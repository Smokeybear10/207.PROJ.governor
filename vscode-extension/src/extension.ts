import * as path from "node:path";
import { randomUUID } from "node:crypto";

import * as vscode from "vscode";
import { registerWorkspaceRepairCommands } from "./workspaceRepairCommands";
import {
  GovernorApiError,
  GovernorHttpClient,
  normalizeBaseUrl
} from "./apiClient";
import {
  forgetKnownJob,
  isValidBudgetUsd,
  normalizeIntegerSetting,
  normalizeKnownJobs,
  rememberKnownJob
} from "./extensionState";
import {
  jobControls,
  loadSavedResponse,
  parseJobList,
  parseJobView,
  parseSubmission,
  promptResultMarkdown,
  riskBand,
  savedResponseMarkdown,
  usd,
  type JobView
} from "./jobModel";
import { jobReportMarkdown, parseJobReport } from "./jobReport";
import { confirmedRequestBody, parseRequestQuote, quoteDetail } from "./requestPreview";
import {
  LocalGovernorServer,
  type LocalServerStatus
} from "./localServer";
import {
  emptyJobHtml,
  escapeHtml,
  isPanelAction,
  jobSectionHtml,
  repairSectionHtml,
  shellHtml,
  type PanelAction,
  type RenderMessage
} from "./panelView";
import {
  RepairClient,
  formatMicroUsd,
  type RepairMode,
  type RepairRunResponse
} from "./repairClient";

const ACTIVE_JOB_KEY = "tokenGovernor.activeJobId";
const KNOWN_JOBS_KEY = "tokenGovernor.knownJobIds";
const OPENAI_API_KEY_SECRET = "tokenGovernor.openAiApiKey";

function apiBaseUrl(): string {
  const configured = vscode.workspace
    .getConfiguration("tokenGovernor")
    .get<string>("apiBaseUrl", "http://127.0.0.1:8787");
  return normalizeBaseUrl(configured);
}

function requestTimeoutMs(): number {
  return normalizeIntegerSetting(
    vscode.workspace
      .getConfiguration("tokenGovernor")
      .get<unknown>("requestTimeoutMs"),
    70_000,
    1_000,
    300_000
  );
}

function pollIntervalMs(): number {
  return normalizeIntegerSetting(
    vscode.workspace
      .getConfiguration("tokenGovernor")
      .get<unknown>("pollIntervalMs"),
    2_000,
    500,
    300_000
  );
}

function providerMode(): RepairMode {
  const configured = vscode.workspace
    .getConfiguration("tokenGovernor")
    .get<unknown>("providerMode");
  return configured === "hybrid" || configured === "live"
    ? configured
    : "fake";
}

async function apiRequest(
  requestPath: string,
  init?: RequestInit,
  signal?: AbortSignal
): Promise<unknown> {
  const client = new GovernorHttpClient({
    baseUrl: apiBaseUrl(),
    timeoutMs: requestTimeoutMs()
  });
  return client.request(requestPath, init, signal);
}

class GovernorViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "tokenGovernor.jobView";

  #view: vscode.WebviewView | undefined;
  onAction: ((action: PanelAction) => void) | undefined;
  onReady: (() => void) | undefined;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = shellHtml(view.webview.cspSource);
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        Array.isArray(message)
      ) {
        return;
      }
      const msg = message as { type?: string; action?: PanelAction };
      if (msg.type === "ready") {
        this.onReady?.();
      } else if (msg.type === "action" && isPanelAction(msg.action)) {
        this.onAction?.(msg.action);
      }
    });
    view.onDidDispose(() => {
      if (this.#view === view) {
        this.#view = undefined;
      }
    });
  }

  post(message: RenderMessage): void {
    void this.#view?.webview.postMessage({ type: "render", ...message });
  }

  reveal(): void {
    this.#view?.show?.(true);
  }
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const output = vscode.window.createOutputChannel("Governor");
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );
  statusBar.command = "tokenGovernor.openJobPanel";
  context.subscriptions.push(output, statusBar);

  const localServer = new LocalGovernorServer({
    serverPath: path.join(context.extensionPath, "out", "governor-server.mjs"),
    stateDirectory: path.join(context.globalStorageUri.fsPath, "jobs"),
    log: (line) => output.appendLine(line)
  });
  context.subscriptions.push(localServer);

  const panel = new GovernorViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GovernorViewProvider.viewId,
      panel,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollingDisposed = false;
  let refreshInFlight: Promise<void> | undefined;
  let refreshQueued = false;
  let repairRunning = false;

  const activeJobId = (): string | undefined => {
    const stored = context.workspaceState.get<unknown>(ACTIVE_JOB_KEY);
    return typeof stored === "string" && stored.trim() ? stored.trim() : undefined;
  };

  const rememberJob = async (jobId: string): Promise<void> => {
    const known = context.workspaceState.get<unknown>(KNOWN_JOBS_KEY);
    const normalizedId = jobId.trim();
    await context.workspaceState.update(
      KNOWN_JOBS_KEY,
      rememberKnownJob(known, normalizedId)
    );
    await context.workspaceState.update(ACTIVE_JOB_KEY, normalizedId);
  };

  const forgetJob = async (jobId: string): Promise<void> => {
    const known = context.workspaceState.get<unknown>(KNOWN_JOBS_KEY);
    await context.workspaceState.update(
      KNOWN_JOBS_KEY,
      forgetKnownJob(known, jobId)
    );
    if (activeJobId() === jobId) {
      await context.workspaceState.update(ACTIVE_JOB_KEY, undefined);
    }
  };

  const localServerOptions = async (): Promise<{
    readonly baseUrl: string;
    readonly enabled: boolean;
    readonly apiKey?: string;
  }> => {
    const config = vscode.workspace.getConfiguration("tokenGovernor");
    const apiKey = await context.secrets.get(OPENAI_API_KEY_SECRET);
    return {
      baseUrl: apiBaseUrl(),
      enabled: config.get<boolean>("autoStartLocalServer", true),
      ...(apiKey ? { apiKey } : {})
    };
  };

  const configureLocalServer = async (
    restart = false
  ): Promise<LocalServerStatus> => {
    const options = await localServerOptions();
    return restart
      ? localServer.restart(options)
      : localServer.ensureRunning(options);
  };

  registerWorkspaceRepairCommands({ context, configureServer: configureLocalServer, baseUrl: apiBaseUrl, timeoutMs: requestTimeoutMs, output });

  const prepareSubmission = async (jobId: string): Promise<{
    job: JobView;
    baseUrl: string;
    client: GovernorHttpClient;
  } | undefined> => {
    try {
      const baseUrl = apiBaseUrl();
      const client = new GovernorHttpClient({ baseUrl, timeoutMs: requestTimeoutMs() });
      await configureLocalServer();
      const job = parseJobView(await client.request(`/v1/jobs/${encodeURIComponent(jobId)}`));
      if (job.id !== jobId) throw new GovernorApiError("The service returned a different job.", 200, "INVALID_RESPONSE");
      const controls = jobControls(job);
      if (!controls.canSubmit) {
        void vscode.window.showWarningMessage(controls.message);
        return;
      }
      const health = await new RepairClient({ baseUrl, timeoutMs: requestTimeoutMs() }).health();
      if (!health.providerConfigured) {
        const action = await vscode.window.showWarningMessage(
          "Prompts need an OpenAI API key. The sample CI repair works without one.",
          "Set API Key"
        );
        if (action) await vscode.commands.executeCommand("tokenGovernor.setOpenAiApiKey");
        return;
      }
      return { job, baseUrl, client };
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Could not check this job.");
      return;
    }
  };

  const choosePhase = (job: JobView): Thenable<string | undefined> => {
    const finalOnly = job.policy.max_responses - job.accounting.responses_started <= 1 ||
      Number(job.accounting.available_for_work_usd) <= 0;
    return vscode.window.showQuickPick(finalOnly ? ["final"] : ["work", "final"], {
      title: "Governor: response phase",
      placeHolder: finalOnly ? "Only the final response remains available for this job" : "Work continues the job; final asks for its last answer"
    });
  };

  const cancellableRequest = <T>(title: string, run: (signal: AbortSignal) => Promise<T>): Thenable<T> =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      try {
        const result = await run(controller.signal);
        if (controller.signal.aborted) throw new GovernorApiError("The Governor request was cancelled.", 0, "CANCELLED");
        return result;
      } finally {
        cancellation.dispose();
      }
    });

  const openSavedResponse = async (client: GovernorHttpClient, jobId: string, requestId: string): Promise<void> => {
    try {
      const saved = await loadSavedResponse(jobId, requestId, (requestPath) => client.request(requestPath));
      if (saved.status !== "ready") {
        void vscode.window.showInformationMessage(saved.message);
        return;
      }
      const document = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: savedResponseMarkdown(jobId, saved.request, saved.submission)
      });
      await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Could not open the saved response.");
    }
  };

  const submitWithPreview = async (
    target: NonNullable<Awaited<ReturnType<typeof prepareSubmission>>>,
    phase: "work" | "final",
    input: string
  ): Promise<void> => {
    const jobId = target.job.id;
    const jobPath = `/v1/jobs/${encodeURIComponent(jobId)}`;
    let requestId: string | undefined;
    try {
      const quote = parseRequestQuote(await cancellableRequest(
        "Governor: counting input tokens only; no response generation...",
        (signal) => target.client.request(`${jobPath}/quote`, {
          method: "POST", body: JSON.stringify({ phase, input })
        }, signal)
      ));
      if (quote.job_id !== jobId || quote.phase !== phase) {
        throw new GovernorApiError("The cost preview does not match this job and phase.", 200, "INVALID_RESPONSE");
      }
      const detail = `${quoteDetail(quote)}\n\nService: ${target.baseUrl}`;
      if (!quote.admitted) {
        await vscode.window.showWarningMessage(
          `Governor cannot send this request: ${quote.reason?.replaceAll("_", " ").toLowerCase()}.`,
          { modal: true, detail }
        );
        return;
      }
      const confirmation = await vscode.window.showInformationMessage(
        `Send this ${phase} response with a $${quote.max_cost_usd} reservation cap?`,
        { modal: true, detail }, "Send"
      );
      if (confirmation !== "Send") return;
      requestId = `${phase}:${randomUUID()}`;
      const body = confirmedRequestBody(quote, requestId, input);
      const submission = parseSubmission(await cancellableRequest(
        `Governor: sending ${requestId}...`,
        (signal) => target.client.request(`${jobPath}/responses`, {
          method: "POST", body: JSON.stringify(body)
        }, signal)
      ));
      output.appendLine(`response ${requestId}: ${JSON.stringify(submission, null, 2)}`);
      const document = await vscode.workspace.openTextDocument({
        language: "markdown", content: promptResultMarkdown(jobId, requestId, phase, input, submission)
      });
      await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    } catch (error) {
      if (requestId && error instanceof GovernorApiError &&
        (["CANCELLED", "TIMEOUT", "NETWORK_ERROR", "INVALID_RESPONSE"].includes(error.code) || error.status >= 500)) {
        output.appendLine(`Interrupted request ${requestId} on ${target.baseUrl}, job ${jobId}: ${error.message}`);
        const action = await vscode.window.showWarningMessage(
          `No confirmed result for ${requestId}. Check the saved response before retrying; generation may still be running within your approved cap.`,
          "Open Saved Response"
        );
        if (action === "Open Saved Response") await openSavedResponse(target.client, jobId, requestId);
        return;
      }
      if (error instanceof GovernorApiError && error.code === "CANCELLED") {
        void vscode.window.showInformationMessage("Cost preview cancelled. No model response was requested.");
        return;
      }
      if (!requestId && error instanceof GovernorApiError && error.status === 404 && error.code !== "JOB_NOT_FOUND") {
        void vscode.window.showErrorMessage("This Governor service does not support cost preview. Update the service before sending a request.");
        return;
      }
      const message = error instanceof Error ? error.message : "Could not complete the governed request.";
      output.appendLine(`${requestId ?? "cost preview"}: ${message}`);
      void vscode.window.showErrorMessage(message);
    } finally {
      void refresh();
    }
  };

  const updateStatusBar = (job: JobView): void => {
    const band = riskBand(job);
    const controls = jobControls(job);
    const state = controls.canSubmit ? band.replace("_", " ") : job.status.replaceAll("_", " ");
    statusBar.text = `$(shield) ${usd(job.accounting.committed_usd)} / ${usd(job.policy.budget_usd)} · ${state}`;
    statusBar.tooltip = new vscode.MarkdownString(
      [
        `**Governor job \`${job.id}\`** — ${job.status}`,
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
  };

  const refreshOnce = async (): Promise<void> => {
    const jobId = activeJobId();
    const mode = providerMode();
    let providerConfigured: boolean | null = null;
    let api = vscode.workspace
      .getConfiguration("tokenGovernor")
      .get<string>("apiBaseUrl", "http://127.0.0.1:8787");
    try {
      api = apiBaseUrl();
      const client = new RepairClient({
        baseUrl: api,
        timeoutMs: Math.min(requestTimeoutMs(), 5_000)
      });
      const health = await client.health();
      providerConfigured = health.providerConfigured;

      if (!jobId) {
        statusBar.hide();
        panel.post({
          api,
          connected: true,
          providerMode: mode,
          providerConfigured,
          jobControls: jobControls(null),
          hasActiveJob: false,
          statusHtml: "",
          jobHtml: emptyJobHtml("No active governed job.")
        });
        return;
      }

      const job = parseJobView(
        await apiRequest(`/v1/jobs/${encodeURIComponent(jobId)}`)
      );
      if (jobId !== activeJobId()) {
        refreshQueued = true;
        return;
      }
      updateStatusBar(job);
      panel.post({
        api,
        connected: true,
        providerMode: mode,
        providerConfigured,
        jobControls: jobControls(job),
        hasActiveJob: true,
        statusHtml: "",
        jobHtml: jobSectionHtml(job)
      });
    } catch (error) {
      if (jobId !== activeJobId()) {
        refreshQueued = true;
        return;
      }
      if (
        jobId &&
        error instanceof GovernorApiError &&
        error.code === "JOB_NOT_FOUND"
      ) {
        await forgetJob(jobId);
        statusBar.hide();
        panel.post({
          api,
          connected: true,
          providerMode: mode,
          providerConfigured,
          jobControls: jobControls(null),
          hasActiveJob: false,
          statusHtml:
            '<div class="banner info">The previous job was not found in the configured service.</div>',
          jobHtml: emptyJobHtml("No active governed job.")
        });
        return;
      }
      if (
        error instanceof GovernorApiError &&
        (error.code === "NETWORK_ERROR" || error.code === "TIMEOUT")
      ) {
        try {
          const status = await configureLocalServer();
          if (status === "managed") {
            refreshQueued = true;
            return;
          }
        } catch (recoveryError) {
          output.appendLine(
            `local server recovery failed: ${
              recoveryError instanceof Error
                ? recoveryError.message
                : String(recoveryError)
            }`
          );
        }
      }
      const message =
        error instanceof Error ? error.message : "Governor request failed.";
      const connected =
        error instanceof GovernorApiError ? error.status > 0 : false;
      statusBar.text = connected
        ? "$(shield) Governor: request failed"
        : "$(shield) Governor: unreachable";
      statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
      statusBar.tooltip = message;
      statusBar.show();
      panel.post({
        api,
        connected,
        providerMode: mode,
        providerConfigured,
        jobControls: jobControls(null),
        hasActiveJob: Boolean(jobId),
        statusHtml: `<div class="banner bad">${escapeHtml(message)}</div>`,
        jobHtml: ""
      });
    }
  };

  const refresh = (): Promise<void> => {
    if (refreshInFlight) {
      refreshQueued = true;
      return refreshInFlight;
    }
    const operation = (async () => {
      do {
        refreshQueued = false;
        await refreshOnce();
      } while (refreshQueued);
    })().finally(() => {
      if (refreshInFlight === operation) {
        refreshInFlight = undefined;
      }
    });
    refreshInFlight = operation;
    return operation;
  };

  const doRepair = async (): Promise<void> => {
    if (repairRunning) return;
    repairRunning = true;
    const config = vscode.workspace.getConfiguration("tokenGovernor");
    const configuredFixture = config.get<unknown>("defaultFixtureId");
    const fixtureId =
      typeof configuredFixture === "string" && configuredFixture.trim()
        ? configuredFixture.trim()
        : "broken-sum";
    const mode: RepairMode = "fake";

    try {
      await vscode.commands.executeCommand(`${GovernorViewProvider.viewId}.focus`);
      panel.reveal();
      panel.post({
        busy: true,
        busyLabel: `Running scripted sample "${fixtureId}". No model call or charge.`,
        statusHtml: ""
      });
      await configureLocalServer();
      const client = new RepairClient({
        baseUrl: apiBaseUrl(),
        timeoutMs: requestTimeoutMs()
      });
      const run = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Running scripted sample “${fixtureId}” — no model charge`,
          cancellable: true
        },
        async (_progress, token) => {
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() =>
            controller.abort()
          );
          try {
            return await client.runRepair(
              { fixtureId, mode },
              controller.signal
            );
          } finally {
            cancellation.dispose();
          }
        }
      );

      appendRepairSummary(output, run);

      const repaired = run.result.status === "repaired";
      const spend = formatMicroUsd(run.result.settledMicroUsd);
      panel.post({
        busy: false,
        busyLabel: "",
        statusHtml: "",
        repairHtml: repairSectionHtml(run)
      });
      void vscode.window.showInformationMessage(
        `Scripted sample: ${repaired ? "tests passed" : "not repaired"}. Simulated cost ${spend}; no model call or charge.`
      );
    } catch (error) {
      if (
        error instanceof GovernorApiError &&
        error.code === "CANCELLED"
      ) {
        output.appendLine("scripted sample cancelled");
        panel.post({
          busy: false,
          busyLabel: "",
          statusHtml: '<div class="banner info">Scripted sample cancelled.</div>'
        });
        return;
      }
      const detail =
        error instanceof GovernorApiError
          ? `[${error.code}] ${error.message}`
          : error instanceof Error
            ? error.message
            : "Scripted sample failed.";
      output.appendLine(`scripted sample failed: ${detail}`);
      panel.post({
        busy: false,
        busyLabel: "",
        statusHtml: `<div class="banner bad">Scripted sample failed: ${escapeHtml(detail)}</div>`
      });
      void vscode.window.showErrorMessage(`Scripted sample failed: ${detail}`);
    } finally {
      repairRunning = false;
      panel.post({ busy: false, busyLabel: "" });
    }
  };

  const schedulePolling = (): void => {
    if (pollTimer) {
      clearTimeout(pollTimer);
    }
    if (pollingDisposed) {
      return;
    }
    pollTimer = setTimeout(() => {
      void refresh()
        .catch((error) => {
          output.appendLine(
            `polling refresh failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        })
        .finally(schedulePolling);
    }, pollIntervalMs());
  };
  context.subscriptions.push({
    dispose: () => {
      pollingDisposed = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
    }
  });

  panel.onReady = () => void refresh();
  panel.onAction = (action) => {
    if (action === "runRepair") {
      void doRepair();
    } else {
      void vscode.commands.executeCommand(`tokenGovernor.${action}`);
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("tokenGovernor.pollIntervalMs")) {
        schedulePolling();
      }
      if (
        event.affectsConfiguration("tokenGovernor.apiBaseUrl") ||
        event.affectsConfiguration("tokenGovernor.autoStartLocalServer")
      ) {
        void configureLocalServer(true)
          .catch((error) => {
            output.appendLine(
              `local server configuration failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          })
          .finally(() => refresh());
      } else if (event.affectsConfiguration("tokenGovernor")) {
        void refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenGovernor.refresh", async () => {
      await refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenGovernor.healthCheck", async () => {
      try {
        await configureLocalServer();
        const health = await new RepairClient({
          baseUrl: apiBaseUrl(),
          timeoutMs: Math.min(requestTimeoutMs(), 5_000)
        }).health();
        output.appendLine(`health: ${JSON.stringify(health)}`);
        void vscode.window.showInformationMessage(
          `Governor is ready at ${apiBaseUrl()}${health.providerConfigured ? " with OpenAI access" : ""}.`
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
        prompt: "Maximum model spend for this job, in USD",
        validateInput: (value) =>
          isValidBudgetUsd(value)
            ? undefined
            : "Enter an amount from 0.000001 to 999999.999999"
      });
      if (!budget) {
        return;
      }
      try {
        await configureLocalServer();
        const job = parseJobView(
          await apiRequest("/v1/jobs", {
            method: "POST",
            body: JSON.stringify({ budget_usd: budget.trim() })
          })
        );
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
      let jobId: string | undefined;
      try {
        await configureLocalServer();
        type JobPick = vscode.QuickPickItem & {
          choice: "job" | "older" | "newest" | "manual";
          id?: string;
        };
        let after: string | null = null;
        while (!jobId) {
          let items: JobPick[];
          let nextAfter: string | null = null;
          try {
            const page = parseJobList(await apiRequest(
              `/v1/jobs?limit=25${after ? `&after=${encodeURIComponent(after)}` : ""}`
            ));
            items = page.data.map((job) => ({
              choice: "job",
              id: job.id,
              label: job.id,
              description: `${job.id === activeJobId() ? "Active · " : ""}${job.status.replaceAll("_", " ")}`,
              detail: `${usd(job.settled_usd)} spent · ${usd(job.reserved_usd)} reserved · ${usd(job.budget_usd)} budget · ${new Date(job.created_at).toLocaleString()}`
            }));
            nextAfter = page.next_after;
            if (page.has_more) items.push({ choice: "older", label: "Older jobs…" });
            if (after) items.push({ choice: "newest", label: "Back to newest jobs" });
          } catch (error) {
            if (!(error instanceof GovernorApiError) || error.status !== 404) throw error;
            output.appendLine("This service does not support saved-job browsing. Showing locally remembered IDs.");
            items = normalizeKnownJobs(context.workspaceState.get<unknown>(KNOWN_JOBS_KEY))
              .map((id) => ({ choice: "job", id, label: id, description: "Locally remembered" }));
          }
          items.push({ choice: "manual", label: "Enter a job ID…" });
          const picked = await vscode.window.showQuickPick(items, {
            title: "Governor: saved jobs",
            placeHolder: items.length === 1 ? "No saved jobs. Create a job or enter its ID." : "Choose a job to inspect or continue",
            matchOnDescription: true,
            matchOnDetail: true
          });
          if (!picked) return;
          if (picked.choice === "older") {
            after = nextAfter;
            continue;
          }
          if (picked.choice === "newest") {
            after = null;
            continue;
          }
          if (picked.choice === "manual") {
            jobId = (await vscode.window.showInputBox({ title: "Governor job ID" }))?.trim();
            if (!jobId) return;
          } else {
            jobId = picked.id;
          }
        }
        const job = parseJobView(
          await apiRequest(`/v1/jobs/${encodeURIComponent(jobId)}`)
        );
        await rememberJob(job.id);
        output.appendLine(`active job: ${job.id}`);
        await refresh();
      } catch (error) {
        if (
          error instanceof GovernorApiError &&
          error.code === "JOB_NOT_FOUND" && jobId
        ) {
          await forgetJob(jobId);
          void vscode.window.showWarningMessage(
            `Governor job ${jobId} was not found in the configured service.`
          );
          return;
        }
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : "Job lookup failed."
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenGovernor.viewResponses", async () => {
      const jobId = activeJobId();
      if (!jobId) {
        void vscode.window.showInformationMessage("Choose a saved job to view its responses.");
        return;
      }
      try {
        const client = new GovernorHttpClient({ baseUrl: apiBaseUrl(), timeoutMs: requestTimeoutMs() });
        await configureLocalServer();
        const job = parseJobView(await client.request(`/v1/jobs/${encodeURIComponent(jobId)}`));
        if (job.id !== jobId) throw new GovernorApiError("The service returned a different job.", 200, "INVALID_RESPONSE");
        const requests = [...job.requests].reverse();
        if (requests.length === 0) {
          void vscode.window.showInformationMessage("This job has no response attempts yet.");
          return;
        }
        const picked = await vscode.window.showQuickPick(requests.map((request) => ({
          label: `${request.sequence}. ${request.request_id}`,
          description: `${request.phase} · ${request.status.replaceAll("_", " ")}`,
          detail: new Date(request.started_at).toLocaleString(),
          request
        })), { title: "Governor: saved responses", placeHolder: "Read a saved result without sending another model request" });
        if (!picked) return;
        await openSavedResponse(client, jobId, picked.request.request_id);
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Could not open the saved response.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenGovernor.openJobPanel", async () => {
      await vscode.commands.executeCommand(`${GovernorViewProvider.viewId}.focus`);
      await refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenGovernor.submitSelection", async () => {
      const jobId = activeJobId();
      if (!jobId) {
        void vscode.window.showWarningMessage("No active governor job. Run “Governor: Create Job” first.");
        return;
      }
      const editor = vscode.window.activeTextEditor;
      const input = editor?.selection.isEmpty ? undefined : editor?.document.getText(editor.selection);
      if (!input) {
        void vscode.window.showWarningMessage("Select the text to submit as the model input.");
        return;
      }
      const target = await prepareSubmission(jobId);
      if (!target) return;
      const phase = await choosePhase(target.job);
      if (phase !== "work" && phase !== "final") return;
      await submitWithPreview(target, phase, input);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenGovernor.sendPrompt", async () => {
      let jobId = activeJobId();
      if (!jobId) {
        const create = await vscode.window.showWarningMessage(
          "No active governor job. Create one to send this prompt through it.", "Create Job"
        );
        if (create !== "Create Job") return;
        await vscode.commands.executeCommand("tokenGovernor.createJob");
        jobId = activeJobId();
        if (!jobId) return;
      }
      const target = await prepareSubmission(jobId);
      if (!target) return;
      const input = await vscode.window.showInputBox({
        title: "Governor: prompt",
        prompt: "Preview token count and maximum cost before generating a response",
        placeHolder: "Ask the model something..."
      });
      if (!input?.trim()) return;
      const phase = await choosePhase(target.job);
      if (phase !== "work" && phase !== "final") return;
      await submitWithPreview(target, phase, input);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenGovernor.exportReport", async () => {
      const jobId = activeJobId();
      if (!jobId) {
        void vscode.window.showInformationMessage("Choose a saved job to export its report.");
        return;
      }
      try {
        const client = new GovernorHttpClient({ baseUrl: apiBaseUrl(), timeoutMs: requestTimeoutMs() });
        await configureLocalServer();
        const report = parseJobReport(await client.request(`/v1/jobs/${encodeURIComponent(jobId)}/report`));
        if (report.job.id !== jobId) {
          throw new GovernorApiError("The report does not match the selected job.", 200, "INVALID_RESPONSE");
        }
        const format = await vscode.window.showQuickPick([
          { label: "Markdown report", extension: "md" },
          { label: "JSON accounting record", extension: "json" }
        ], { title: "Governor: export job report", placeHolder: "Prompts and model outputs are excluded" });
        if (!format) return;
        const name = `${jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}-report.${format.extension}`;
        const directory = vscode.workspace.workspaceFolders?.[0]?.uri ?? context.globalStorageUri;
        const destination = await vscode.window.showSaveDialog({
          title: "Save Governor job report",
          defaultUri: vscode.Uri.joinPath(directory, name),
          filters: format.extension === "md" ? { Markdown: ["md"] } : { JSON: ["json"] }
        });
        if (!destination) return;
        const content = format.extension === "md" ? jobReportMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`;
        await vscode.workspace.fs.writeFile(destination, Buffer.from(content, "utf8"));
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(destination), {
          preview: false, viewColumn: vscode.ViewColumn.Beside
        });
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Could not export the job report.");
      }
    })
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
        await configureLocalServer();
        job = parseJobView(
          await apiRequest(`/v1/jobs/${encodeURIComponent(jobId)}`)
        );
      } catch (error) {
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : "Job lookup failed."
        );
        return;
      }
      const pending = job.pending_final_validation_request_id;
      if (!pending || !jobControls(job).canFinalize) {
        void vscode.window.showInformationMessage(
          jobControls(job).message
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
        const result = parseJobView(
          await apiRequest(
            `/v1/jobs/${encodeURIComponent(jobId)}/finalize`,
            {
              method: "POST",
              body: JSON.stringify({
                request_id: pending,
                accepted: decision.startsWith("Accept")
              })
            }
          )
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

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "tokenGovernor.setOpenAiApiKey",
      async () => {
        const apiKey = await vscode.window.showInputBox({
          title: "Governor: OpenAI API key",
          prompt:
            "Stored in VS Code Secret Storage and used only by the managed local Governor service.",
          password: true,
          ignoreFocusOut: true,
          validateInput: (value) =>
            value.trim() === "" ? "Enter a non-empty API key." : undefined
        });
        if (apiKey === undefined) {
          return;
        }
        await context.secrets.store(OPENAI_API_KEY_SECRET, apiKey.trim());
        try {
          const status = await configureLocalServer(true);
          output.appendLine(`OpenAI API key updated; server status: ${status}`);
          await refresh();
          const detail =
            status === "managed"
              ? " The managed local service was restarted."
              : status === "external"
                ? " The configured service is externally managed and was not restarted."
                : " Local service auto-start is disabled for the configured URL.";
          void vscode.window.showInformationMessage(
            `Governor stored the OpenAI API key securely.${detail}`
          );
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Governor stored the key, but could not restart the local service: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "tokenGovernor.clearOpenAiApiKey",
      async () => {
        await context.secrets.delete(OPENAI_API_KEY_SECRET);
        try {
          const status = await configureLocalServer(true);
          output.appendLine(`OpenAI API key cleared; server status: ${status}`);
          await refresh();
          void vscode.window.showInformationMessage(
            "Governor cleared the OpenAI API key from Secret Storage."
          );
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Governor cleared the key, but could not restart the local service: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenGovernor.runRepair", () => doRepair())
  );

  try {
    const status = await configureLocalServer();
    output.appendLine(`local server status: ${status}`);
  } catch (error) {
    output.appendLine(
      `local server startup failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  schedulePolling();
  await refresh();
}

function appendRepairSummary(
  output: vscode.OutputChannel,
  run: RepairRunResponse
): void {
  const { result } = run;
  output.appendLine("──────────────────────────────────────────");
  output.appendLine(`Scripted sample — ${new Date().toISOString()}`);
  output.appendLine("  No model call or charge. Costs below use scripted token usage.");
  output.appendLine(`  fixture:   ${run.fixtureId}`);
  output.appendLine(`  mode:      ${run.mode}`);
  output.appendLine(`  rate card: ${run.rateCardVersion || "n/a"}`);
  output.appendLine(
    `  verdict:   ${result.status === "repaired" ? "sample tests passed" : "not repaired"}${result.reason ? ` (${result.reason})` : ""}`
  );
  output.appendLine(`  simulated cost: ${formatMicroUsd(result.settledMicroUsd)}`);
  output.appendLine(`  toolCalls: ${result.toolCalls}`);
  output.appendLine(`  revision:  ${result.revision || "n/a"}`);

  if (result.evaluation) {
    const evaluation = result.evaluation;
    output.appendLine("  sealed evaluation:");
    output.appendLine(`    passed:         ${evaluation.passed}`);
    output.appendLine(`    targetPassed:   ${evaluation.targetPassed}`);
    output.appendLine(`    policyRespected:${evaluation.policyRespected}`);
    output.appendLine(`    exitCode:       ${evaluation.exitCode}`);
    output.appendLine(
      `    violations:     ${evaluation.violations.length ? evaluation.violations.join(", ") : "none"}`
    );
  } else {
    output.appendLine("  sealed evaluation: none");
  }

  output.appendLine("  finalText:");
  if (result.finalText) {
    for (const line of result.finalText.split("\n")) {
      output.appendLine(`    ${line}`);
    }
  } else {
    output.appendLine("    (none)");
  }

  output.appendLine("  governed trace:");
  if (result.trace.length) {
    for (const event of result.trace) {
      const detail = [event.name, event.phase, event.status, event.state]
        .filter((part): part is string => Boolean(part))
        .join(" ");
      output.appendLine(
        `    #${event.sequence} ${event.kind}${detail ? ` ${detail}` : ""}`
      );
    }
  } else {
    output.appendLine("    (empty)");
  }
}

export function deactivate(): void {
  // Poll timers and UI are disposed through context.subscriptions.
}
