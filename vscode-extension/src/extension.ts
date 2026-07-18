import * as vscode from "vscode";

const ACTIVE_JOB_KEY = "tokenGovernor.activeJobId";
const KNOWN_JOBS_KEY = "tokenGovernor.knownJobIds";
const USD_PATTERN = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/;

// Mirrors DEFAULT_RISK_THRESHOLDS in server/governor/risk.ts. The jobs API
// does not expose the shadow risk assessment yet, so the extension derives
// the budget-utilization band from the same basis-point thresholds.
const WATCH_COMMITTED_BPS = 7_000;
const AT_RISK_COMMITTED_BPS = 9_000;

type RiskBand = "SAFE" | "WATCH" | "AT_RISK";

type JobRequestSummary = {
  sequence: number;
  request_id: string;
  phase: "work" | "final";
  status: string;
  started_at: string;
};

type JobView = {
  id: string;
  status: string;
  policy: {
    budget_micro_usd: number;
    budget_usd: string;
    final_reserve_micro_usd: number;
    final_reserve_usd: string;
    max_responses: number;
  };
  accounting: {
    settled_micro_usd: number;
    settled_usd: string;
    reserved_micro_usd: number;
    reserved_usd: string;
    committed_micro_usd: number;
    committed_usd: string;
    uncommitted_micro_usd: number;
    uncommitted_usd: string;
    available_for_work_usd: string;
    responses_started: number;
  };
  pending_final_validation_request_id: string | null;
  completion_accepted: boolean | null;
  requests: JobRequestSummary[];
};

class GovernorApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function apiBaseUrl(): string {
  const configured = vscode.workspace
    .getConfiguration("tokenGovernor")
    .get<string>("apiBaseUrl", "http://127.0.0.1:8787");
  return configured.replace(/\/+$/, "");
}

function pollIntervalMs(): number {
  return Math.max(
    500,
    vscode.workspace
      .getConfiguration("tokenGovernor")
      .get<number>("pollIntervalMs", 2000)
  );
}

async function apiRequest<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers
      }
    });
  } catch (error) {
    throw new GovernorApiError(
      `Could not reach the governor at ${apiBaseUrl()}. Is the server running?`,
      0,
      "UNREACHABLE"
    );
  }

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const errorValue = body.error as
      | { message?: string; code?: string }
      | undefined;
    throw new GovernorApiError(
      errorValue?.message ?? `Request failed with HTTP ${response.status}.`,
      response.status,
      errorValue?.code ?? `HTTP_${response.status}`
    );
  }
  return body as T;
}

function riskBand(job: JobView): RiskBand {
  const budget = Math.max(1, job.policy.budget_micro_usd);
  const committedBps = Math.floor(
    (job.accounting.committed_micro_usd * 10_000) / budget
  );
  if (committedBps >= AT_RISK_COMMITTED_BPS) {
    return "AT_RISK";
  }
  if (committedBps >= WATCH_COMMITTED_BPS) {
    return "WATCH";
  }
  return "SAFE";
}

function usd(value: string): string {
  return `$${value}`;
}

function requestStatusTone(status: string): "ok" | "warn" | "bad" {
  const normalized = status.toLowerCase();
  if (
    normalized.includes("denied") ||
    normalized.includes("rejected") ||
    normalized.includes("failed") ||
    normalized.includes("ambiguous")
  ) {
    return "bad";
  }
  if (normalized.includes("progress") || normalized.includes("pending")) {
    return "warn";
  }
  return "ok";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function panelHtml(job: JobView): string {
  const band = riskBand(job);
  const budget = Math.max(1, job.policy.budget_micro_usd);
  const pct = (micro: number): string =>
    `${Math.min(100, (micro / budget) * 100).toFixed(2)}%`;
  const bandColor =
    band === "AT_RISK"
      ? "var(--vscode-charts-red)"
      : band === "WATCH"
        ? "var(--vscode-charts-yellow)"
        : "var(--vscode-charts-green)";

  const requestRows = job.requests
    .map((request) => {
      const tone = requestStatusTone(request.status);
      const toneColor =
        tone === "bad"
          ? "var(--vscode-charts-red)"
          : tone === "warn"
            ? "var(--vscode-charts-yellow)"
            : "var(--vscode-charts-green)";
      return `<tr>
        <td>${request.sequence}</td>
        <td><code>${escapeHtml(request.request_id)}</code></td>
        <td>${escapeHtml(request.phase)}</td>
        <td><span class="chip" style="border-color:${toneColor};color:${toneColor}">${escapeHtml(request.status)}</span></td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 14px 18px;
  }
  h2 { margin: 0 0 2px; font-size: 15px; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 14px; }
  .band {
    display: inline-block; margin-left: 8px; padding: 1px 8px;
    border: 1px solid ${bandColor}; border-radius: 999px;
    color: ${bandColor}; font-size: 11px; font-weight: 600;
  }
  .bar {
    display: flex; height: 14px; border-radius: 4px; overflow: hidden;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border, transparent);
    margin: 6px 0 4px;
  }
  .bar .settled { background: var(--vscode-charts-green); width: ${pct(job.accounting.settled_micro_usd)}; }
  .bar .reserved { background: var(--vscode-charts-yellow); width: ${pct(job.accounting.reserved_micro_usd)}; }
  .legend { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 14px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 4px 10px 4px 0; border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25)); }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  dl { display: grid; grid-template-columns: max-content auto; gap: 3px 14px; font-size: 12px; margin: 0 0 16px; }
  dt { color: var(--vscode-descriptionForeground); }
  dd { margin: 0; font-variant-numeric: tabular-nums; }
  .chip { padding: 0 7px; border: 1px solid; border-radius: 999px; font-size: 11px; }
  code { font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
  <h2>Job <code>${escapeHtml(job.id)}</code><span class="band">${band.replace("_", " ")}</span></h2>
  <p class="sub">status: ${escapeHtml(job.status)} · responses started: ${job.accounting.responses_started}/${job.policy.max_responses}</p>

  <div class="bar" title="settled + reserved against the budget">
    <span class="settled"></span><span class="reserved"></span>
  </div>
  <p class="legend">
    settled ${usd(job.accounting.settled_usd)} ·
    reserved ${usd(job.accounting.reserved_usd)} ·
    available for work ${usd(job.accounting.available_for_work_usd)} ·
    budget ${usd(job.policy.budget_usd)}
  </p>

  <dl>
    <dt>Budget</dt><dd>${usd(job.policy.budget_usd)}</dd>
    <dt>Settled</dt><dd>${usd(job.accounting.settled_usd)}</dd>
    <dt>Reserved</dt><dd>${usd(job.accounting.reserved_usd)}</dd>
    <dt>Committed</dt><dd>${usd(job.accounting.committed_usd)}</dd>
    <dt>Uncommitted</dt><dd>${usd(job.accounting.uncommitted_usd)}</dd>
    <dt>Protected final reserve</dt><dd>${usd(job.policy.final_reserve_usd)}</dd>
    <dt>Pending validation</dt><dd>${escapeHtml(job.pending_final_validation_request_id ?? "none")}</dd>
  </dl>

  <table>
    <thead><tr><th>#</th><th>Request</th><th>Phase</th><th>Status</th></tr></thead>
    <tbody>${requestRows || `<tr><td colspan="4">No responses submitted yet.</td></tr>`}</tbody>
  </table>
</body>
</html>`;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("TokenGovernor");
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );
  statusBar.command = "tokenGovernor.openJobPanel";
  context.subscriptions.push(output, statusBar);

  let panel: vscode.WebviewPanel | undefined;
  let lastPanelHtml = "";
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const activeJobId = (): string | undefined =>
    context.workspaceState.get<string>(ACTIVE_JOB_KEY);

  const rememberJob = async (jobId: string): Promise<void> => {
    const known = context.workspaceState.get<string[]>(KNOWN_JOBS_KEY, []);
    if (!known.includes(jobId)) {
      await context.workspaceState.update(KNOWN_JOBS_KEY, [jobId, ...known]);
    }
    await context.workspaceState.update(ACTIVE_JOB_KEY, jobId);
  };

  const renderJob = (job: JobView): void => {
    const band = riskBand(job);
    statusBar.text = `$(shield) ${usd(job.accounting.committed_usd)} / ${usd(job.policy.budget_usd)} ${band.replace("_", " ")}`;
    statusBar.tooltip = new vscode.MarkdownString(
      [
        `**TokenGovernor job \`${job.id}\`** — ${job.status}`,
        "",
        `- Settled: ${usd(job.accounting.settled_usd)}`,
        `- Reserved: ${usd(job.accounting.reserved_usd)}`,
        `- Available for work: ${usd(job.accounting.available_for_work_usd)}`,
        `- Responses: ${job.accounting.responses_started}/${job.policy.max_responses}`,
        "",
        "Click to open the job panel."
      ].join("\n")
    );
    statusBar.backgroundColor =
      band === "AT_RISK"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : band === "WATCH"
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
    statusBar.show();

    if (panel) {
      const html = panelHtml(job);
      if (html !== lastPanelHtml) {
        panel.webview.html = html;
        lastPanelHtml = html;
      }
    }
  };

  const refresh = async (): Promise<void> => {
    const jobId = activeJobId();
    if (!jobId) {
      statusBar.hide();
      return;
    }
    try {
      const job = await apiRequest<JobView>(
        `/v1/jobs/${encodeURIComponent(jobId)}`
      );
      renderJob(job);
    } catch (error) {
      statusBar.text = "$(shield) Governor: unreachable";
      statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
      statusBar.tooltip =
        error instanceof Error ? error.message : "Governor request failed.";
      statusBar.show();
    }
  };

  const restartPolling = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    pollTimer = setInterval(() => void refresh(), pollIntervalMs());
    context.subscriptions.push({
      dispose: () => pollTimer && clearInterval(pollTimer)
    });
  };
  restartPolling();
  void refresh();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("tokenGovernor")) {
        restartPolling();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenGovernor.healthCheck", async () => {
      try {
        const health = await apiRequest<Record<string, unknown>>(
          "/api/health"
        );
        output.appendLine(`health: ${JSON.stringify(health)}`);
        void vscode.window.showInformationMessage(
          `Governor is up at ${apiBaseUrl()}.`
        );
      } catch (error) {
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : "Health check failed."
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenGovernor.createJob", async () => {
      const budget = await vscode.window.showInputBox({
        title: "Governor: job budget in USD",
        value: "0.075",
        prompt: "Decimal USD string, at most six fractional digits",
        validateInput: (value) =>
          USD_PATTERN.test(value.trim())
            ? undefined
            : "Enter a decimal USD amount like 0.075"
      });
      if (!budget) {
        return;
      }
      try {
        const job = await apiRequest<JobView>("/v1/jobs", {
          method: "POST",
          body: JSON.stringify({ budget_usd: budget.trim() })
        });
        await rememberJob(job.id);
        output.appendLine(`created job: ${JSON.stringify(job, null, 2)}`);
        void refresh();
        const open = await vscode.window.showInformationMessage(
          `Created governed job ${job.id} with a ${usd(job.policy.budget_usd)} budget.`,
          "Open Job Panel"
        );
        if (open) {
          await vscode.commands.executeCommand("tokenGovernor.openJobPanel");
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : "Job creation failed."
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenGovernor.setActiveJob", async () => {
      const known = context.workspaceState.get<string[]>(KNOWN_JOBS_KEY, []);
      const manualLabel = "$(edit) Enter a job id...";
      const picked = await vscode.window.showQuickPick(
        [...known.map((id) => ({ label: id })), { label: manualLabel }],
        { title: "Governor: pick the active job" }
      );
      if (!picked) {
        return;
      }
      let jobId = picked.label;
      if (jobId === manualLabel) {
        const manual = await vscode.window.showInputBox({
          title: "Governor job id"
        });
        if (!manual) {
          return;
        }
        jobId = manual.trim();
      }
      await rememberJob(jobId);
      void refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenGovernor.openJobPanel", async () => {
      if (!activeJobId()) {
        void vscode.window.showWarningMessage(
          "No active governor job. Run “Governor: Create Job” first."
        );
        return;
      }
      if (panel) {
        panel.reveal();
      } else {
        panel = vscode.window.createWebviewPanel(
          "tokenGovernorJob",
          "Governor Job",
          vscode.ViewColumn.Beside,
          { enableScripts: false }
        );
        panel.onDidDispose(() => {
          panel = undefined;
          lastPanelHtml = "";
        });
      }
      await refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "tokenGovernor.submitSelection",
      async () => {
        const jobId = activeJobId();
        if (!jobId) {
          void vscode.window.showWarningMessage(
            "No active governor job. Run “Governor: Create Job” first."
          );
          return;
        }
        const editor = vscode.window.activeTextEditor;
        const input = editor?.selection.isEmpty
          ? undefined
          : editor?.document.getText(editor.selection);
        if (!input) {
          void vscode.window.showWarningMessage(
            "Select the text to submit as the model input."
          );
          return;
        }
        const phase = await vscode.window.showQuickPick(["work", "final"], {
          title: "Governor: response phase"
        });
        if (phase !== "work" && phase !== "final") {
          return;
        }
        const requestId = `${phase}:${Date.now()}`;
        try {
          const result = await apiRequest<Record<string, unknown>>(
            `/v1/jobs/${encodeURIComponent(jobId)}/responses`,
            {
              method: "POST",
              body: JSON.stringify({
                request_id: requestId,
                phase,
                input
              })
            }
          );
          output.appendLine(
            `response ${requestId}: ${JSON.stringify(result, null, 2)}`
          );
          void refresh();
          void vscode.window.showInformationMessage(
            `Governor admitted ${requestId}. Details in the TokenGovernor output channel.`
          );
        } catch (error) {
          void refresh();
          if (error instanceof GovernorApiError) {
            output.appendLine(
              `response ${requestId} refused: [${error.code}] ${error.message}`
            );
            void vscode.window.showWarningMessage(
              `Governor refused ${requestId} (${error.code}): ${error.message}`
            );
            return;
          }
          void vscode.window.showErrorMessage(
            error instanceof Error ? error.message : "Submission failed."
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenGovernor.finalize", async () => {
      const jobId = activeJobId();
      if (!jobId) {
        void vscode.window.showWarningMessage("No active governor job.");
        return;
      }
      let job: JobView;
      try {
        job = await apiRequest<JobView>(
          `/v1/jobs/${encodeURIComponent(jobId)}`
        );
      } catch (error) {
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : "Job lookup failed."
        );
        return;
      }
      const pending = job.pending_final_validation_request_id;
      if (!pending) {
        void vscode.window.showInformationMessage(
          "No final response is waiting for validation."
        );
        return;
      }
      const decision = await vscode.window.showQuickPick(
        ["Accept final output", "Reject final output"],
        { title: `Finalize ${pending}` }
      );
      if (!decision) {
        return;
      }
      try {
        const result = await apiRequest<Record<string, unknown>>(
          `/v1/jobs/${encodeURIComponent(jobId)}/finalize`,
          {
            method: "POST",
            body: JSON.stringify({
              request_id: pending,
              accepted: decision.startsWith("Accept")
            })
          }
        );
        output.appendLine(`finalize: ${JSON.stringify(result, null, 2)}`);
        void refresh();
        void vscode.window.showInformationMessage(
          `Job ${jobId} finalized: ${decision.startsWith("Accept") ? "accepted" : "rejected"}.`
        );
      } catch (error) {
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : "Finalize failed."
        );
      }
    })
  );
}

export function deactivate(): void {
  // Poll timers and UI are disposed through context.subscriptions.
}
