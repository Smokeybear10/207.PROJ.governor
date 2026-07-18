import { randomBytes } from "node:crypto";
import * as path from "node:path";

import * as vscode from "vscode";
import {
  GovernorApiError,
  GovernorHttpClient,
  normalizeBaseUrl
} from "./apiClient";
import {
  LocalGovernorServer,
  type LocalServerStatus
} from "./localServer";
import {
  RepairClient,
  formatMicroUsd,
  type RepairRunResponse
} from "./repairClient";

const ACTIVE_JOB_KEY = "tokenGovernor.activeJobId";
const KNOWN_JOBS_KEY = "tokenGovernor.knownJobIds";
const OPENAI_API_KEY_SECRET = "tokenGovernor.openAiApiKey";
const USD_PATTERN = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/;
const PANEL_ACTIONS = new Set<PanelAction>([
  "healthCheck",
  "createJob",
  "setActiveJob",
  "submitSelection",
  "sendPrompt",
  "finalize",
  "runRepair",
  "refresh"
]);

// Mirrors DEFAULT_RISK_THRESHOLDS in server/governor/risk.ts. The jobs API
// does not expose the shadow risk assessment yet, so the extension derives
// the budget-utilization band from the same basis-point thresholds.
const WATCH_COMMITTED_BPS = 7_000;
const AT_RISK_COMMITTED_BPS = 9_000;

type RiskBand = "SAFE" | "WATCH" | "AT_RISK";

type PanelAction =
  | "healthCheck"
  | "createJob"
  | "setActiveJob"
  | "submitSelection"
  | "sendPrompt"
  | "finalize"
  | "runRepair"
  | "refresh";

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

type SubmissionResponse = {
  model: string;
  status: string;
  output: unknown[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  } | null;
};

type SubmissionExecution = {
  status: string;
  reason?: string;
  response?: SubmissionResponse | null;
  reservation?: {
    exact_input_tokens: number;
    max_output_tokens: number;
    reserved_usd: string;
    settled_usd: string | null;
  };
};

type ResponseSubmission = {
  execution: SubmissionExecution;
  job: JobView;
};

function apiBaseUrl(): string {
  const configured = vscode.workspace
    .getConfiguration("tokenGovernor")
    .get<string>("apiBaseUrl", "http://127.0.0.1:8787");
  return normalizeBaseUrl(configured);
}

function requestTimeoutMs(): number {
  return Math.max(
    1_000,
    vscode.workspace
      .getConfiguration("tokenGovernor")
      .get<number>("requestTimeoutMs", 70_000)
  );
}

function pollIntervalMs(): number {
  return Math.max(
    500,
    vscode.workspace
      .getConfiguration("tokenGovernor")
      .get<number>("pollIntervalMs", 2000)
  );
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

function invalidApiResponse(pathName: string, expected: string): never {
  throw new GovernorApiError(
    `Governor response field "${pathName}" must be ${expected}.`,
    200,
    "INVALID_RESPONSE"
  );
}

function apiRecord(
  value: unknown,
  pathName: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidApiResponse(pathName, "an object");
  }
  return value as Record<string, unknown>;
}

function apiString(value: unknown, pathName: string): string {
  if (typeof value !== "string") {
    invalidApiResponse(pathName, "a string");
  }
  return value;
}

function apiNumber(value: unknown, pathName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidApiResponse(pathName, "a finite number");
  }
  return value;
}

function apiNullableString(value: unknown, pathName: string): string | null {
  if (value === null) {
    return null;
  }
  return apiString(value, pathName);
}

function parseJobView(value: unknown): JobView {
  const record = apiRecord(value, "job");
  const policy = apiRecord(record.policy, "job.policy");
  const accounting = apiRecord(record.accounting, "job.accounting");
  if (!Array.isArray(record.requests)) {
    invalidApiResponse("job.requests", "an array");
  }
  const completionAccepted =
    record.completion_accepted === null
      ? null
      : typeof record.completion_accepted === "boolean"
        ? record.completion_accepted
        : invalidApiResponse("job.completion_accepted", "a boolean or null");
  return {
    id: apiString(record.id, "job.id"),
    status: apiString(record.status, "job.status"),
    policy: {
      budget_micro_usd: apiNumber(
        policy.budget_micro_usd,
        "job.policy.budget_micro_usd"
      ),
      budget_usd: apiString(policy.budget_usd, "job.policy.budget_usd"),
      final_reserve_micro_usd: apiNumber(
        policy.final_reserve_micro_usd,
        "job.policy.final_reserve_micro_usd"
      ),
      final_reserve_usd: apiString(
        policy.final_reserve_usd,
        "job.policy.final_reserve_usd"
      ),
      max_responses: apiNumber(
        policy.max_responses,
        "job.policy.max_responses"
      )
    },
    accounting: {
      settled_micro_usd: apiNumber(
        accounting.settled_micro_usd,
        "job.accounting.settled_micro_usd"
      ),
      settled_usd: apiString(
        accounting.settled_usd,
        "job.accounting.settled_usd"
      ),
      reserved_micro_usd: apiNumber(
        accounting.reserved_micro_usd,
        "job.accounting.reserved_micro_usd"
      ),
      reserved_usd: apiString(
        accounting.reserved_usd,
        "job.accounting.reserved_usd"
      ),
      committed_micro_usd: apiNumber(
        accounting.committed_micro_usd,
        "job.accounting.committed_micro_usd"
      ),
      committed_usd: apiString(
        accounting.committed_usd,
        "job.accounting.committed_usd"
      ),
      uncommitted_micro_usd: apiNumber(
        accounting.uncommitted_micro_usd,
        "job.accounting.uncommitted_micro_usd"
      ),
      uncommitted_usd: apiString(
        accounting.uncommitted_usd,
        "job.accounting.uncommitted_usd"
      ),
      available_for_work_usd: apiString(
        accounting.available_for_work_usd,
        "job.accounting.available_for_work_usd"
      ),
      responses_started: apiNumber(
        accounting.responses_started,
        "job.accounting.responses_started"
      )
    },
    pending_final_validation_request_id: apiNullableString(
      record.pending_final_validation_request_id,
      "job.pending_final_validation_request_id"
    ),
    completion_accepted: completionAccepted,
    requests: record.requests.map((rawRequest, index) => {
      const request = apiRecord(rawRequest, `job.requests[${index}]`);
      const phase = request.phase;
      if (phase !== "work" && phase !== "final") {
        invalidApiResponse(
          `job.requests[${index}].phase`,
          '"work" or "final"'
        );
      }
      return {
        sequence: apiNumber(
          request.sequence,
          `job.requests[${index}].sequence`
        ),
        request_id: apiString(
          request.request_id,
          `job.requests[${index}].request_id`
        ),
        phase,
        status: apiString(
          request.status,
          `job.requests[${index}].status`
        ),
        started_at: apiString(
          request.started_at,
          `job.requests[${index}].started_at`
        )
      };
    })
  };
}

function parseSubmission(value: unknown): ResponseSubmission {
  const record = apiRecord(value, "submission");
  const execution = apiRecord(record.execution, "submission.execution");
  const parsed: SubmissionExecution = {
    status: apiString(execution.status, "submission.execution.status")
  };
  if (execution.reason !== undefined) {
    parsed.reason = apiString(
      execution.reason,
      "submission.execution.reason"
    );
  }
  if (execution.response !== undefined && execution.response !== null) {
    const response = apiRecord(
      execution.response,
      "submission.execution.response"
    );
    if (!Array.isArray(response.output)) {
      invalidApiResponse(
        "submission.execution.response.output",
        "an array"
      );
    }
    let usage: SubmissionResponse["usage"] = null;
    if (response.usage !== undefined && response.usage !== null) {
      const rawUsage = apiRecord(
        response.usage,
        "submission.execution.response.usage"
      );
      usage = {
        input_tokens: apiNumber(
          rawUsage.input_tokens,
          "submission.execution.response.usage.input_tokens"
        ),
        output_tokens: apiNumber(
          rawUsage.output_tokens,
          "submission.execution.response.usage.output_tokens"
        ),
        total_tokens: apiNumber(
          rawUsage.total_tokens,
          "submission.execution.response.usage.total_tokens"
        )
      };
    }
    parsed.response = {
      model: apiString(
        response.model,
        "submission.execution.response.model"
      ),
      status: apiString(
        response.status,
        "submission.execution.response.status"
      ),
      output: response.output,
      usage
    };
  } else {
    parsed.response = null;
  }
  if (execution.reservation !== undefined) {
    const reservation = apiRecord(
      execution.reservation,
      "submission.execution.reservation"
    );
    parsed.reservation = {
      exact_input_tokens: apiNumber(
        reservation.exact_input_tokens,
        "submission.execution.reservation.exact_input_tokens"
      ),
      max_output_tokens: apiNumber(
        reservation.max_output_tokens,
        "submission.execution.reservation.max_output_tokens"
      ),
      reserved_usd: apiString(
        reservation.reserved_usd,
        "submission.execution.reservation.reserved_usd"
      ),
      settled_usd: apiNullableString(
        reservation.settled_usd,
        "submission.execution.reservation.settled_usd"
      )
    };
  }
  return {
    execution: parsed,
    job: parseJobView(record.job)
  };
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

// Pulls the plain text out of a Responses API output array: message items
// whose content pieces are typed "output_text". Work-phase outputs can also
// carry function-call items; those have no text and are skipped here.
function collectOutputText(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const piece of content) {
      if (
        typeof piece === "object" &&
        piece !== null &&
        (piece as { type?: unknown }).type === "output_text" &&
        typeof (piece as { text?: unknown }).text === "string"
      ) {
        parts.push((piece as { text: string }).text);
      }
    }
  }
  return parts.join("\n").trim();
}

function promptResultMarkdown(
  jobId: string,
  requestId: string,
  phase: string,
  prompt: string,
  submission: ResponseSubmission
): string {
  const execution = submission.execution;
  const response = execution.response ?? null;
  const reservation = execution.reservation;
  const lines = [
    `# Governor response \`${requestId}\``,
    "",
    `- Job: \`${jobId}\``,
    `- Phase: ${phase}`,
    `- Execution: ${execution.status}${execution.reason ? ` (${execution.reason})` : ""}`
  ];
  if (response) {
    lines.push(`- Model: ${response.model}`);
    if (response.usage) {
      lines.push(
        `- Tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`
      );
    }
  }
  if (reservation) {
    lines.push(
      `- Reserved: ${usd(reservation.reserved_usd)}` +
        (reservation.settled_usd === null
          ? " (not settled)"
          : `, settled: ${usd(reservation.settled_usd)}`)
    );
  }
  lines.push("", "## Prompt", "", prompt, "", "## Answer", "");
  const answer = response === null ? "" : collectOutputText(response.output);
  if (answer) {
    lines.push(answer);
  } else if (response) {
    lines.push(
      "The response contained no plain text output. Raw output:",
      "",
      "```json",
      JSON.stringify(response.output, null, 2),
      "```"
    );
  } else {
    lines.push(
      "No provider response is available for this outcome. Check the " +
        "Governor output channel and the job panel."
    );
  }
  return `${lines.join("\n")}\n`;
}

function nonce(): string {
  return randomBytes(24).toString("base64");
}

function isPanelAction(value: unknown): value is PanelAction {
  return typeof value === "string" && PANEL_ACTIONS.has(value as PanelAction);
}

const VIEW_STYLES = `
  :root { --gap: 12px; }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 10px 12px 20px;
    font-size: 12px;
  }
  body.busy { opacity: 0.55; pointer-events: none; }
  .topbar {
    display: flex; align-items: center; gap: 8px;
    padding-bottom: 8px; margin-bottom: 10px;
    border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25));
  }
  .brand { font-weight: 700; letter-spacing: 0.02em; display: flex; align-items: center; gap: 7px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
  .dot.ok { background: var(--vscode-charts-green); }
  .dot.bad { background: var(--vscode-charts-red); }
  .api { margin-left: auto; font-size: 10px; color: var(--vscode-descriptionForeground); word-break: break-all; text-align: right; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  button {
    font-family: inherit; font-size: 11px; cursor: pointer;
    padding: 5px 10px; border-radius: 5px;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.16));
    border: 1px solid transparent;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.28)); }
  button.primary {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    font-weight: 600;
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.ghost { padding: 5px 8px; }
  .banner { padding: 8px 10px; border-radius: 6px; margin-bottom: 12px; font-size: 11px; }
  .banner.bad { background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.12)); border: 1px solid var(--vscode-charts-red); }
  .banner.info { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border, transparent); }
  .kicker {
    color: var(--vscode-descriptionForeground);
    font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; margin: 0 0 4px;
  }
  h2 { margin: 0; font-size: 13px; word-break: break-all; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 4px 0 0; }
  .band {
    display: inline-block; margin: 8px 0 0; padding: 1px 8px;
    border: 1px solid; border-radius: 999px;
    font-size: 10px; font-weight: 700;
  }
  .hero { margin: 12px 0 2px; font-size: 19px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .hero small { font-size: 11px; font-weight: 500; color: var(--vscode-descriptionForeground); }
  .bar {
    display: flex; height: 12px; border-radius: 4px; overflow: hidden;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border, transparent);
    margin: 6px 0 12px;
  }
  .bar .settled { background: var(--vscode-charts-green); }
  .bar .reserved { background: var(--vscode-charts-yellow); }
  dl { display: grid; grid-template-columns: 1fr max-content; gap: 4px 10px; font-size: 12px; margin: 0 0 14px; }
  dt { color: var(--vscode-descriptionForeground); }
  dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; word-break: break-all; }
  h3 {
    margin: 16px 0 6px; font-size: 10px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
  }
  .request { padding: 6px 0; border-top: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25)); }
  .request-head { display: flex; align-items: center; gap: 6px; }
  .request-head .phase { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .chip { padding: 0 7px; border: 1px solid; border-radius: 999px; font-size: 10px; white-space: nowrap; }
  .request-head .chip { margin-left: auto; }
  .request code { display: block; margin-top: 3px; font-size: 11px; word-break: break-all; }
  .empty { color: var(--vscode-descriptionForeground); font-size: 12px; }
  code { font-family: var(--vscode-editor-font-family); }

  .card {
    border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
    border-radius: 8px; padding: 12px; margin-top: 6px;
    background: var(--vscode-editorWidget-background);
  }
  .card.repaired { border-left: 3px solid var(--vscode-charts-green); }
  .card.failed { border-left: 3px solid var(--vscode-charts-red); }
  .repair-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .verdict { font-weight: 700; font-size: 13px; }
  .verdict.ok { color: var(--vscode-charts-green); }
  .verdict.bad { color: var(--vscode-charts-red); }
  .spend { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; }
  .checks { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
  .pill { padding: 2px 8px; border-radius: 999px; font-size: 10px; border: 1px solid; }
  .pill.ok { color: var(--vscode-charts-green); border-color: var(--vscode-charts-green); }
  .pill.bad { color: var(--vscode-charts-red); border-color: var(--vscode-charts-red); }
  .pill.neutral { color: var(--vscode-descriptionForeground); border-color: var(--vscode-descriptionForeground); }
  details { margin: 8px 0; }
  summary { cursor: pointer; font-size: 11px; color: var(--vscode-descriptionForeground); }
  pre {
    white-space: pre-wrap; word-break: break-word; margin: 6px 0 0;
    font-family: var(--vscode-editor-font-family); font-size: 11px;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
    padding: 8px; border-radius: 6px;
  }
  ol.trace { list-style: none; margin: 0; padding: 0; }
  ol.trace li {
    display: flex; gap: 8px; align-items: baseline; padding: 4px 0;
    border-top: 1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.25));
    font-size: 11px;
  }
  ol.trace .seq { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; min-width: 22px; }
  ol.trace .k { font-weight: 600; }
  ol.trace .k.tool { color: var(--vscode-charts-blue); }
  ol.trace .k.response { color: var(--vscode-charts-purple, var(--vscode-charts-blue)); }
  ol.trace .d { color: var(--vscode-descriptionForeground); }
`;

function shellHtml(webview: vscode.Webview): string {
  const cspSource = webview.cspSource;
  const scriptNonce = nonce();
  const script = `
    const vscode = acquireVsCodeApi();
    for (const b of document.querySelectorAll('button[data-action]')) {
      b.addEventListener('click', function () {
        vscode.postMessage({ type: 'action', action: b.getAttribute('data-action') });
      });
    }
    window.addEventListener('message', function (e) {
      var m = e.data;
      if (!m || m.type !== 'render') return;
      if (m.api !== undefined) document.getElementById('api').textContent = m.api;
      if (m.connected !== undefined) document.getElementById('dot').className = 'dot ' + (m.connected ? 'ok' : 'bad');
      if (m.statusHtml !== undefined) document.getElementById('status').innerHTML = m.statusHtml;
      if (m.jobHtml !== undefined) document.getElementById('job').innerHTML = m.jobHtml;
      if (m.repairHtml !== undefined) document.getElementById('repair').innerHTML = m.repairHtml;
      if (m.busy !== undefined) document.body.classList.toggle('busy', !!m.busy);
    });
    vscode.postMessage({ type: 'ready' });
  `;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${scriptNonce}';" />
  <style>${VIEW_STYLES}</style>
</head>
<body>
  <div class="topbar">
    <div class="brand"><span class="dot" id="dot"></span> Governor</div>
    <div class="api" id="api"></div>
  </div>
  <div class="actions">
    <button class="primary" data-action="runRepair">Run CI-Repair</button>
    <button data-action="createJob">Create Job</button>
    <button data-action="setActiveJob">Switch Job</button>
    <button data-action="submitSelection">Submit Selection</button>
    <button data-action="sendPrompt">Send Prompt</button>
    <button data-action="finalize">Finalize</button>
    <button data-action="healthCheck">Health</button>
    <button class="ghost" data-action="refresh" title="Refresh">↻</button>
  </div>
  <div id="status"></div>
  <div id="job"></div>
  <div id="repair"></div>
  <script nonce="${scriptNonce}">${script}</script>
</body>
</html>`;
}

function emptyJobHtml(message: string): string {
  return `<p class="kicker">Active governed job</p><p class="empty">${escapeHtml(message)}</p>`;
}

function jobSectionHtml(job: JobView): string {
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
      return `<div class="request">
        <div class="request-head">
          <strong>#${request.sequence}</strong>
          <span class="phase">${escapeHtml(request.phase)}</span>
          <span class="chip" style="border-color:${toneColor};color:${toneColor}">${escapeHtml(request.status)}</span>
        </div>
        <code>${escapeHtml(request.request_id)}</code>
      </div>`;
    })
    .join("");

  return `
  <p class="kicker">Active governed job</p>
  <h2><code>${escapeHtml(job.id)}</code></h2>
  <p class="sub">status: ${escapeHtml(job.status)} · responses ${job.accounting.responses_started}/${job.policy.max_responses}</p>
  <span class="band" style="border-color:${bandColor};color:${bandColor}">${band.replace("_", " ")}</span>

  <p class="hero">${escapeHtml(usd(job.accounting.committed_usd))} <small>of ${escapeHtml(usd(job.policy.budget_usd))} committed</small></p>
  <div class="bar" title="settled + reserved against the budget">
    <span class="settled" style="width:${pct(job.accounting.settled_micro_usd)}"></span>
    <span class="reserved" style="width:${pct(job.accounting.reserved_micro_usd)}"></span>
  </div>

  <dl>
    <dt>Settled</dt><dd>${escapeHtml(usd(job.accounting.settled_usd))}</dd>
    <dt>Reserved</dt><dd>${escapeHtml(usd(job.accounting.reserved_usd))}</dd>
    <dt>Uncommitted</dt><dd>${escapeHtml(usd(job.accounting.uncommitted_usd))}</dd>
    <dt>Available for work</dt><dd>${escapeHtml(usd(job.accounting.available_for_work_usd))}</dd>
    <dt>Protected final reserve</dt><dd>${escapeHtml(usd(job.policy.final_reserve_usd))}</dd>
    <dt>Pending validation</dt><dd>${escapeHtml(job.pending_final_validation_request_id ?? "none")}</dd>
  </dl>

  <h3>Requests</h3>
  ${requestRows || `<p class="empty">No responses submitted yet.</p>`}
  `;
}

function pill(label: string, ok: boolean): string {
  return `<span class="pill ${ok ? "ok" : "bad"}">${escapeHtml(label)}</span>`;
}

function repairSectionHtml(run: RepairRunResponse): string {
  const result = run.result;
  const repaired = result.status === "repaired";
  const spend = formatMicroUsd(result.settledMicroUsd);
  const evaluation = result.evaluation;

  const checks = evaluation
    ? [
        pill(`passed ${evaluation.passed ? "✓" : "✕"}`, evaluation.passed),
        pill(
          `tests ${evaluation.targetPassed ? "✓" : "✕"}`,
          evaluation.targetPassed
        ),
        pill(
          `policy ${evaluation.policyRespected ? "✓" : "✕"}`,
          evaluation.policyRespected
        ),
        `<span class="pill neutral">exit ${evaluation.exitCode}</span>`,
        `<span class="pill neutral">${result.toolCalls} tool calls</span>`
      ].join("")
    : `<span class="pill neutral">no sealed evaluation</span>`;

  const violations =
    evaluation && evaluation.violations.length
      ? `<div class="banner bad" style="margin-top:8px">violations: ${escapeHtml(evaluation.violations.join(", "))}</div>`
      : "";

  const trace = result.trace.length
    ? `<ol class="trace">${result.trace
        .map((event) => {
          const detail = [event.name, event.phase, event.status, event.state]
            .filter((part): part is string => Boolean(part))
            .join(" · ");
          const kindClass = event.kind === "tool" ? "tool" : "response";
          return `<li><span class="seq">#${event.sequence}</span><span class="k ${kindClass}">${escapeHtml(event.kind)}</span><span class="d">${escapeHtml(detail)}</span></li>`;
        })
        .join("")}</ol>`
    : `<p class="empty">No trace events.</p>`;

  const finalText = result.finalText
    ? `<details open><summary>Final summary</summary><pre>${escapeHtml(result.finalText)}</pre></details>`
    : "";

  return `
  <h3>Latest CI-repair</h3>
  <div class="card ${repaired ? "repaired" : "failed"}">
    <div class="repair-head">
      <span class="verdict ${repaired ? "ok" : "bad"}">${repaired ? "Repaired ✓" : "Not repaired"}</span>
      <span class="spend">${escapeHtml(spend)}</span>
    </div>
    <p class="sub">${escapeHtml(run.fixtureId)} · ${escapeHtml(run.mode)} · ${escapeHtml(run.model || "n/a")}${result.reason ? ` · ${escapeHtml(result.reason)}` : ""}</p>
    <div class="checks">${checks}</div>
    ${violations}
    ${finalText}
    <h3>Governed trace</h3>
    ${trace}
  </div>
  `;
}

type RenderMessage = {
  api?: string;
  connected?: boolean;
  statusHtml?: string;
  jobHtml?: string;
  repairHtml?: string;
  busy?: boolean;
};

class GovernorViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "tokenGovernor.jobView";

  #view: vscode.WebviewView | undefined;
  onAction: ((action: PanelAction) => void) | undefined;
  onReady: (() => void) | undefined;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = shellHtml(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => {
      const msg = message as { type?: string; action?: PanelAction };
      if (msg?.type === "ready") {
        this.onReady?.();
      } else if (msg?.type === "action" && isPanelAction(msg.action)) {
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

  const activeJobId = (): string | undefined =>
    context.workspaceState.get<string>(ACTIVE_JOB_KEY);

  const rememberJob = async (jobId: string): Promise<void> => {
    const known = context.workspaceState.get<string[]>(KNOWN_JOBS_KEY, []);
    if (!known.includes(jobId)) {
      await context.workspaceState.update(KNOWN_JOBS_KEY, [jobId, ...known]);
    }
    await context.workspaceState.update(ACTIVE_JOB_KEY, jobId);
  };

  const forgetJob = async (jobId: string): Promise<void> => {
    const known = context.workspaceState.get<string[]>(KNOWN_JOBS_KEY, []);
    await context.workspaceState.update(
      KNOWN_JOBS_KEY,
      known.filter((knownId) => knownId !== jobId)
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
    let api = vscode.workspace
      .getConfiguration("tokenGovernor")
      .get<string>("apiBaseUrl", "http://127.0.0.1:8787");
    try {
      api = apiBaseUrl();
      if (!jobId) {
        const client = new RepairClient({
          baseUrl: api,
          timeoutMs: Math.min(requestTimeoutMs(), 5_000)
        });
        await client.health();
        statusBar.hide();
        panel.post({
          api,
          connected: true,
          statusHtml: "",
          jobHtml: emptyJobHtml(
            "No active governed job. Click “Create Job”, or just “Run CI-Repair”."
          )
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
          statusHtml:
            '<div class="banner info">The previous job expired when the local service restarted.</div>',
          jobHtml: emptyJobHtml("Create a job to start a new governed session.")
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
    const fixtureId = config.get<string>("defaultFixtureId", "broken-sum");
    const mode = config.get<"fake" | "hybrid" | "live">("providerMode", "fake");

    panel.reveal();
    panel.post({
      busy: true,
      statusHtml: `<div class="banner info">Running governed CI-repair on “${escapeHtml(fixtureId)}” (${escapeHtml(mode)})…</div>`
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
    if (action === "refresh") {
      void refresh();
    } else if (action === "runRepair") {
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
          USD_PATTERN.test(value.trim())
            ? undefined
            : "Enter a decimal USD amount like 0.075"
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
