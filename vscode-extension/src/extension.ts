import * as path from "node:path";

import * as vscode from "vscode";
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
  parseJobView,
  parseSubmission,
  promptResultMarkdown,
  riskBand,
  usd,
  type JobView
} from "./jobModel";
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

  const updateStatusBar = (job: JobView): void => {
    const band = riskBand(job);
    statusBar.text = `$(shield) ${usd(job.accounting.committed_usd)} / ${usd(job.policy.budget_usd)} ${band.replace("_", " ")}`;
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
          statusHtml: "",
          jobHtml: emptyJobHtml("No active governed job.")
        });
        return;
      }

      const job = parseJobView(
        await apiRequest(`/v1/jobs/${encodeURIComponent(jobId)}`)
      );
      updateStatusBar(job);
      panel.post({
        api,
        connected: true,
        providerMode: mode,
        providerConfigured,
        statusHtml: "",
        jobHtml: jobSectionHtml(job)
      });
    } catch (error) {
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
          statusHtml:
            '<div class="banner info">The previous job expired when the local service restarted.</div>',
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
    const config = vscode.workspace.getConfiguration("tokenGovernor");
    const configuredFixture = config.get<unknown>("defaultFixtureId");
    const fixtureId =
      typeof configuredFixture === "string" && configuredFixture.trim()
        ? configuredFixture.trim()
        : "broken-sum";
    const mode = providerMode();

    await vscode.commands.executeCommand(
      `${GovernorViewProvider.viewId}.focus`
    );
    panel.reveal();
    panel.post({
      busy: true,
      busyLabel: `Running governed CI repair on "${fixtureId}" (${mode})...`,
      statusHtml: ""
    });

    try {
      await configureLocalServer();
      const client = new RepairClient({
        baseUrl: apiBaseUrl(),
        timeoutMs: requestTimeoutMs()
      });
      if (mode !== "fake") {
        const health = await client.health();
        if (!health.providerConfigured) {
          throw new GovernorApiError(
            `OpenAI API access is required for ${mode} mode. Run “Governor: Set OpenAI API Key” first.`,
            503,
            "PROVIDER_NOT_CONFIGURED"
          );
        }
      }
      const run = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Running governed CI-repair on “${fixtureId}” (${mode})…`,
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
        `Governed CI-repair: ${repaired ? "Repaired ✓" : "Not repaired"} · spend ${spend}.`
      );
    } catch (error) {
      if (
        error instanceof GovernorApiError &&
        error.code === "CANCELLED"
      ) {
        output.appendLine("repair cancelled");
        panel.post({
          busy: false,
          busyLabel: "",
          statusHtml: '<div class="banner info">CI-repair cancelled.</div>'
        });
        return;
      }
      const detail =
        error instanceof GovernorApiError
          ? `[${error.code}] ${error.message}`
          : error instanceof Error
            ? error.message
            : "Governed CI-repair failed.";
      output.appendLine(`repair failed: ${detail}`);
      panel.post({
        busy: false,
        busyLabel: "",
        statusHtml: `<div class="banner bad">CI-repair failed: ${escapeHtml(detail)}</div>`
      });
      void vscode.window.showErrorMessage(`Governed CI-repair failed: ${detail}`);
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
        prompt: "Decimal USD string, at most six fractional digits",
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
      const known = normalizeKnownJobs(
        context.workspaceState.get<unknown>(KNOWN_JOBS_KEY)
      );
      const manualLabel = "$(edit) Enter a job id...";
      const picked = await vscode.window.showQuickPick(
        [
          ...known.map((id) => ({
            label: id,
            description: id === activeJobId() ? "active" : undefined
          })),
          { label: manualLabel }
        ],
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
      if (!jobId) {
        return;
      }

      try {
        await configureLocalServer();
        const job = parseJobView(
          await apiRequest(`/v1/jobs/${encodeURIComponent(jobId)}`)
        );
        await rememberJob(job.id);
        output.appendLine(`active job: ${job.id}`);
        await refresh();
      } catch (error) {
        if (
          error instanceof GovernorApiError &&
          error.code === "JOB_NOT_FOUND"
        ) {
          await forgetJob(jobId);
          void vscode.window.showWarningMessage(
            `Governor job ${jobId} was not found. It may have expired when the local service restarted.`
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
    vscode.commands.registerCommand("tokenGovernor.openJobPanel", async () => {
      await vscode.commands.executeCommand(`${GovernorViewProvider.viewId}.focus`);
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
          await configureLocalServer();
          const result = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Governor: dispatching ${requestId}...`,
              cancellable: true
            },
            async (_progress, token) => {
              const controller = new AbortController();
              const cancellation = token.onCancellationRequested(() =>
                controller.abort()
              );
              try {
                return parseSubmission(
                  await apiRequest(
                    `/v1/jobs/${encodeURIComponent(jobId)}/responses`,
                    {
                      method: "POST",
                      body: JSON.stringify({
                        request_id: requestId,
                        phase,
                        input
                      })
                    },
                    controller.signal
                  )
                );
              } finally {
                cancellation.dispose();
              }
            }
          );
          output.appendLine(
            `response ${requestId}: ${JSON.stringify(result, null, 2)}`
          );
          void refresh();
          void vscode.window.showInformationMessage(
            `Governor admitted ${requestId}. Details are in the Governor output channel.`
          );
        } catch (error) {
          void refresh();
          if (error instanceof GovernorApiError) {
            if (error.code === "CANCELLED") {
              void vscode.window.showInformationMessage(
                `Governor cancelled ${requestId}.`
              );
              return;
            }
            output.appendLine(
              `response ${requestId} refused: [${error.code}] ${error.message}`
            );
            const message = `Governor ${error.status > 0 ? "refused" : "could not submit"} ${requestId} (${error.code}): ${error.message}`;
            if (error.status > 0) {
              void vscode.window.showWarningMessage(message);
            } else {
              void vscode.window.showErrorMessage(message);
            }
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
    vscode.commands.registerCommand("tokenGovernor.sendPrompt", async () => {
      let jobId = activeJobId();
      if (!jobId) {
        const create = await vscode.window.showWarningMessage(
          "No active governor job. Create one to send this prompt through it.",
          "Create Job"
        );
        if (create !== "Create Job") {
          return;
        }
        await vscode.commands.executeCommand("tokenGovernor.createJob");
        jobId = activeJobId();
        if (!jobId) {
          return;
        }
      }
      const prompt = await vscode.window.showInputBox({
        title: "Governor: prompt",
        prompt: "Sent as the model input through the active governed job",
        placeHolder: "Ask the model something..."
      });
      if (!prompt || prompt.trim() === "") {
        return;
      }
      const phase = await vscode.window.showQuickPick(["work", "final"], {
        title: "Governor: response phase"
      });
      if (phase !== "work" && phase !== "final") {
        return;
      }

      const requestId = `${phase}:${Date.now()}`;
      const jobPath = encodeURIComponent(jobId);
      try {
        await configureLocalServer();
        const submission = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Governor: dispatching ${requestId}...`,
            cancellable: true
          },
          async (_progress, token) => {
            const controller = new AbortController();
            const cancellation = token.onCancellationRequested(() =>
              controller.abort()
            );
            try {
              return parseSubmission(
                await apiRequest(
                  `/v1/jobs/${jobPath}/responses`,
                  {
                    method: "POST",
                    body: JSON.stringify({
                      request_id: requestId,
                      phase,
                      input: prompt
                    })
                  },
                  controller.signal
                )
              );
            } finally {
              cancellation.dispose();
            }
          }
        );
        output.appendLine(
          `prompt ${requestId}: ${JSON.stringify(submission, null, 2)}`
        );
        void refresh();
        const document = await vscode.workspace.openTextDocument({
          language: "markdown",
          content: promptResultMarkdown(
            jobId,
            requestId,
            phase,
            prompt,
            submission
          )
        });
        await vscode.window.showTextDocument(document, {
          preview: false,
          viewColumn: vscode.ViewColumn.Beside
        });
      } catch (error) {
        void refresh();
        if (error instanceof GovernorApiError) {
          if (error.code === "CANCELLED") {
            void vscode.window.showInformationMessage(
              `Governor cancelled ${requestId}.`
            );
            return;
          }
          output.appendLine(
            `prompt ${requestId} refused: [${error.code}] ${error.message}`
          );
          const message = `Governor ${error.status > 0 ? "refused" : "could not submit"} ${requestId} (${error.code}): ${error.message}`;
          if (error.status > 0) {
            void vscode.window.showWarningMessage(message);
          } else {
            void vscode.window.showErrorMessage(message);
          }
          return;
        }
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : "Prompt submission failed."
        );
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
  output.appendLine(`Governed CI-repair — ${new Date().toISOString()}`);
  output.appendLine(`  fixture:   ${run.fixtureId}`);
  output.appendLine(`  mode:      ${run.mode}`);
  output.appendLine(`  model:     ${run.model || "n/a"}`);
  output.appendLine(`  rate card: ${run.rateCardVersion || "n/a"}`);
  output.appendLine(
    `  verdict:   ${result.status === "repaired" ? "repaired ✓" : "not repaired"}${result.reason ? ` (${result.reason})` : ""}`
  );
  output.appendLine(`  spend:     ${formatMicroUsd(result.settledMicroUsd)}`);
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
