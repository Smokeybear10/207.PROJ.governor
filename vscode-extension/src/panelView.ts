import { randomBytes } from "node:crypto";

import {
  jobControls,
  riskBand,
  type JobControls,
  type JobView
} from "./jobModel";
import {
  formatMicroUsd,
  type RepairMode,
  type RepairRunResponse
} from "./repairClient";

export type PanelAction =
  | "createJob"
  | "setActiveJob"
  | "submitSelection"
  | "sendPrompt"
  | "viewResponses"
  | "exportReport"
  | "finalize"
  | "runRepair"
  | "repairWorkspace"
  | "reviewWorkspaceRepair";

export type RenderMessage = {
  api?: string;
  connected?: boolean;
  providerMode?: RepairMode;
  providerConfigured?: boolean | null;
  statusHtml?: string;
  jobHtml?: string;
  repairHtml?: string;
  busy?: boolean;
  busyLabel?: string;
  jobControls?: JobControls;
  hasActiveJob?: boolean;
};

const PANEL_ACTIONS = new Set<PanelAction>([
  "createJob",
  "setActiveJob",
  "submitSelection",
  "sendPrompt",
  "viewResponses",
  "exportReport",
  "finalize",
  "runRepair",
  "repairWorkspace",
  "reviewWorkspaceRepair"
]);

const MAX_VISIBLE_REQUESTS = 8;

export function isPanelAction(value: unknown): value is PanelAction {
  return typeof value === "string" && PANEL_ACTIONS.has(value as PanelAction);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nonce(): string {
  return randomBytes(24).toString("base64");
}

function requestStatusTone(status: string): "ok" | "warn" | "bad" {
  const normalized = status.toLowerCase();
  if (
    normalized.includes("denied") ||
    normalized.includes("rejected") ||
    normalized.includes("failed") ||
    normalized.includes("ambiguous") ||
    normalized.includes("stopped") ||
    normalized.includes("cancelled")
  ) {
    return "bad";
  }
  if (
    normalized.includes("progress") ||
    normalized.includes("pending") ||
    normalized.includes("unresolved")
  ) {
    return "warn";
  }
  return normalized === "settled" ? "ok" : "warn";
}

const VIEW_STYLES = `
  :root {
    color-scheme: light dark;
    --border: var(--vscode-panel-border, var(--vscode-editorWidget-border, rgba(127, 127, 127, 0.32)));
    --muted: var(--vscode-descriptionForeground);
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body {
    margin: 0;
    padding: 0 0 18px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    font: 12px/1.45 var(--vscode-font-family);
    letter-spacing: 0;
  }
  button {
    min-width: 0;
    min-height: 28px;
    padding: 5px 9px;
    overflow: hidden;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground);
    font: 500 12px/1.35 var(--vscode-font-family);
    letter-spacing: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  button:focus-visible,
  summary:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  button:disabled {
    cursor: default;
    opacity: 0.62;
  }
  button.primary {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  button.primary:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }
  code, pre {
    font-family: var(--vscode-editor-font-family);
  }
  .app-header {
    padding: 12px;
    border-bottom: 1px solid var(--border);
  }
  .identity-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .brand {
    min-width: 0;
    font-size: 14px;
    font-weight: 700;
  }
  .service-row {
    display: flex;
    flex-wrap: wrap;
    gap: 5px 12px;
    margin-top: 8px;
  }
  .service-state,
  .provider-state {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 5px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }
  .service-state.offline,
  .provider-state.bad {
    color: var(--vscode-testing-iconFailed, var(--vscode-charts-red));
    border-color: color-mix(in srgb, currentColor 55%, transparent);
  }
  .provider-state.warn {
    color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow));
    border-color: color-mix(in srgb, currentColor 55%, transparent);
  }
  .endpoint {
    margin-top: 6px;
    overflow: hidden;
    color: var(--muted);
    font: 10px/1.4 var(--vscode-editor-font-family);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .endpoint:empty { display: none; }
  .progress-track {
    position: relative;
    height: 2px;
    overflow: hidden;
    background: var(--vscode-progressBar-background);
  }
  .progress-track::after {
    position: absolute;
    width: 38%;
    height: 100%;
    background: var(--vscode-button-foreground);
    content: "";
    animation: governor-progress 1.2s ease-in-out infinite;
  }
  @keyframes governor-progress {
    from { transform: translateX(-110%); }
    to { transform: translateX(300%); }
  }
  .operation {
    padding: 7px 12px 0;
    color: var(--muted);
    font-size: 11px;
  }
  .operation:empty { display: none; }
  .actions {
    padding: 12px;
  }
  .primary-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }
  .primary-actions + .job-actions { margin-top: 6px; }
  .workflow-note { margin: 8px 0 0; color: var(--muted); font-size: 11px; }
  .prompt-controls { margin-top: 14px; }
  .prompt-controls summary { padding: 10px 0; color: var(--vscode-foreground); font-size: 12px; }
  .action-label,
  .section-label {
    margin: 12px 0 6px;
    color: var(--muted);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: uppercase;
  }
  .job-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }
  .banner {
    margin: 0 12px 10px;
    padding: 8px 9px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .banner.bad {
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-errorBackground);
    border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-charts-red));
  }
  .banner.info {
    color: var(--vscode-inputValidation-infoForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-infoBackground, var(--vscode-editorWidget-background));
    border-color: var(--vscode-inputValidation-infoBorder, var(--border));
  }
  .section {
    padding: 14px 12px;
    border-top: 1px solid var(--border);
  }
  .section-heading {
    display: flex;
    min-width: 0;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }
  .section-heading > div { min-width: 0; flex: 1; }
  .section-label {
    margin: 0 0 3px;
  }
  h2 {
    min-width: 0;
    margin: 0;
    font-size: 12px;
    font-weight: 600;
  }
  h2 code {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  h3 {
    margin: 14px 0 6px;
    color: var(--muted);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: uppercase;
  }
  .sub {
    margin: 3px 0 0;
    color: var(--muted);
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .risk,
  .request-status,
  .check {
    flex: 0 0 auto;
    padding: 1px 6px;
    border: 1px solid currentColor;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    line-height: 1.45;
  }
  .tone-ok,
  .risk-safe {
    color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
  }
  .tone-warn,
  .risk-watch {
    color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow));
  }
  .tone-bad,
  .risk-at-risk {
    color: var(--vscode-testing-iconFailed, var(--vscode-charts-red));
  }
  .budget-summary {
    margin-top: 14px;
  }
  .budget-amount {
    font-size: 20px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1.15;
  }
  .budget-caption {
    margin-top: 2px;
    color: var(--muted);
    font-size: 11px;
  }
  .budget-bar {
    display: flex;
    height: 8px;
    margin-top: 9px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--vscode-editorWidget-background);
  }
  .budget-bar .settled {
    background: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
  }
  .budget-bar .reserved {
    background: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow));
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 6px;
    color: var(--muted);
    font-size: 10px;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .legend i {
    width: 6px;
    height: 6px;
    border-radius: 1px;
  }
  .legend .settled { background: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
  .legend .reserved { background: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow)); }
  .metrics {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin: 14px 0 0;
    border-top: 1px solid var(--border);
    border-left: 1px solid var(--border);
  }
  .metric {
    min-width: 0;
    padding: 7px 8px;
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .metric dt {
    color: var(--muted);
    font-size: 10px;
  }
  .metric dd {
    margin: 2px 0 0;
    overflow: hidden;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .request-list {
    margin: 0;
    padding: 0;
    list-style: none;
    border-bottom: 1px solid var(--border);
  }
  .request {
    padding: 7px 0;
    border-top: 1px solid var(--border);
  }
  .request-head {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 6px;
  }
  .request-sequence {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .request-phase {
    min-width: 0;
    overflow: hidden;
    color: var(--muted);
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .request-status {
    max-width: 52%;
    margin-left: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .request code {
    display: block;
    margin-top: 3px;
    overflow: hidden;
    color: var(--muted);
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    margin: 5px 0 0;
    color: var(--muted);
    font-size: 11px;
  }
  .repair-card {
    margin-top: 7px;
  }
  .repair-head {
    display: flex;
    min-width: 0;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .verdict {
    min-width: 0;
    overflow: hidden;
    font-size: 12px;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spend {
    min-width: 0;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .cost-label { color: var(--muted); font-size: 11px; font-weight: 400; }
  .sample-note { margin: 8px 0; }
  .checks {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin: 9px 0;
  }
  .check.neutral {
    color: var(--muted);
  }
  details {
    margin-top: 8px;
    border-top: 1px solid var(--border);
  }
  summary {
    padding: 7px 0 2px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }
  pre {
    max-height: 240px;
    margin: 5px 0 0;
    padding: 8px;
    overflow: auto;
    border-radius: 3px;
    background: var(--vscode-textCodeBlock-background);
    font-size: 10px;
    line-height: 1.45;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .trace {
    margin: 5px 0 0;
    padding: 0;
    list-style: none;
  }
  .trace li {
    display: grid;
    grid-template-columns: 24px minmax(38px, 70px) minmax(0, 1fr);
    gap: 5px;
    padding: 4px 0;
    border-top: 1px dashed var(--border);
    font-size: 10px;
  }
  .trace-sequence,
  .trace-detail { color: var(--muted); }
  .trace-kind {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .trace-detail { overflow-wrap: anywhere; }
  @media (max-width: 260px) {
    .primary-actions,
    .job-actions,
    .metrics {
      grid-template-columns: minmax(0, 1fr);
    }
    .identity-row {
      align-items: flex-start;
      flex-direction: column;
      gap: 1px;
    }
    .repair-head { align-items: flex-start; flex-direction: column; gap: 4px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .progress-track::after { animation: none; width: 100%; }
  }
`;

export function shellHtml(cspSource: string): string {
  const scriptNonce = nonce();
  const script = `
    const vscode = acquireVsCodeApi();
    const buttons = Array.from(document.querySelectorAll('button[data-action]'));
    const connection = document.getElementById('connection');
    const connectionLabel = document.getElementById('connection-label');
    const provider = document.getElementById('provider');
    const providerLabel = document.getElementById('provider-label');
    const endpoint = document.getElementById('api');
    const progress = document.getElementById('progress');
    const operation = document.getElementById('operation');
    const actionHint = document.getElementById('action-hint');
    let providerConfigured = null;
    let connected = false;
    let busy = false;
    let hasActiveJob = false;
    let controls = { canSubmit: false, canFinalize: false, canViewResponses: false };

    function renderControls() {
      for (const button of buttons) {
        const action = button.getAttribute('data-action');
        let allowed = false;
        if (action === 'createJob' || action === 'setActiveJob') allowed = true;
        if (action === 'sendPrompt' || action === 'submitSelection') {
          allowed = controls.canSubmit === true && providerConfigured === true;
        }
        if (action === 'finalize') allowed = controls.canFinalize === true;
        if (action === 'viewResponses') allowed = controls.canViewResponses === true;
        if (action === 'exportReport') allowed = hasActiveJob;
        if (action === 'repairWorkspace') allowed = providerConfigured === true;
        if (action === 'reviewWorkspaceRepair') allowed = true;
        if (action === 'runRepair') allowed = true;
        button.disabled = !connected || busy || !allowed;
      }
      actionHint.textContent = !connected
        ? 'Connect to Governor to view saved jobs or send requests.'
        : providerConfigured === false
          ? 'The sample runs without a model or API key. Your own files require an OpenAI API key.'
          : '';
      actionHint.hidden = actionHint.textContent === '';
      document.getElementById('job').hidden = !hasActiveJob;
    }

    function renderProvider() {
      provider.className = 'provider-state';
      if (providerConfigured === true) {
        provider.classList.add('ok');
        providerLabel.textContent = 'OpenAI configured';
      } else if (providerConfigured === false) {
        providerLabel.textContent = 'No API key';
      } else {
        providerLabel.textContent = 'Checking provider';
      }
    }

    for (const button of buttons) {
      button.addEventListener('click', function () {
        if (button.disabled) return;
        vscode.postMessage({
          type: 'action',
          action: button.getAttribute('data-action')
        });
      });
    }

    window.addEventListener('message', function (event) {
      const message = event.data;
      if (!message || message.type !== 'render') return;

      if (message.api !== undefined) {
        endpoint.textContent = message.api;
        endpoint.title = message.api;
      }
      if (message.connected !== undefined) {
        connected = message.connected === true;
        connection.className = 'service-state ' + (message.connected ? 'online' : 'offline');
        connectionLabel.textContent = message.connected ? 'Service ready' : 'Service unavailable';
      }
      if (Object.prototype.hasOwnProperty.call(message, 'providerConfigured')) {
        providerConfigured = message.providerConfigured;
      }
      renderProvider();
      if (message.jobControls !== undefined) {
        controls = message.jobControls;
      }
      if (message.hasActiveJob !== undefined) {
        const nextHasJob = message.hasActiveJob === true;
        if (nextHasJob && !hasActiveJob) document.getElementById('prompt-controls').open = true;
        hasActiveJob = nextHasJob;
      }

      if (message.statusHtml !== undefined) {
        document.getElementById('status').innerHTML = message.statusHtml;
      }
      if (message.jobHtml !== undefined) {
        document.getElementById('job').innerHTML = message.jobHtml;
      }
      if (message.repairHtml !== undefined) {
        document.getElementById('repair').innerHTML = message.repairHtml;
      }
      if (message.busy !== undefined) {
        busy = Boolean(message.busy);
        document.body.classList.toggle('is-busy', busy);
        document.body.setAttribute('aria-busy', String(busy));
        progress.hidden = !busy;
        operation.textContent = busy ? (message.busyLabel || 'Governor is working...') : '';
      }
      renderControls();
    });

    renderProvider();
    renderControls();
    vscode.postMessage({ type: 'ready' });
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${scriptNonce}';" />
  <style>${VIEW_STYLES}</style>
</head>
<body aria-busy="false">
  <header class="app-header">
    <div class="identity-row">
      <div class="brand">Governor</div>
    </div>
    <div class="service-row" aria-live="polite">
      <span class="service-state" id="connection">
        <span id="connection-label">Checking service</span>
      </span>
      <span class="provider-state" id="provider">
        <span id="provider-label">Checking provider</span>
      </span>
    </div>
    <details><summary>Connection</summary><div class="endpoint" id="api"></div></details>
  </header>
  <div class="progress-track" id="progress" role="progressbar" aria-label="Governor operation in progress" hidden></div>
  <div class="operation" id="operation" role="status" aria-live="polite"></div>
  <nav class="actions" aria-label="Governor actions">
    <div class="primary-actions">
      <button class="primary" data-action="repairWorkspace" title="Repair selected native Node tests in an isolated copy">Repair Node tests</button>
    </div>
    <div class="job-actions">
      <button data-action="reviewWorkspaceRepair">Review repair</button>
      <button data-action="runRepair" title="Run the scripted example locally, with no model call or charge">Run sample</button>
    </div>
    <p class="workflow-note">macOS · Self-contained JS/TS tests using <code>node:test</code>.</p>
    <p class="empty" id="action-hint" role="status"></p>
    <details class="prompt-controls" id="prompt-controls">
    <summary>Prompt jobs</summary>
    <div class="job-actions">
      <button data-action="createJob">New job</button>
      <button data-action="setActiveJob">Saved jobs</button>
      <button data-action="sendPrompt" title="Send a prompt through the active job">Send prompt</button>
      <button data-action="submitSelection" title="Submit the current editor selection">Submit selection</button>
      <button data-action="finalize" title="Accept or reject the pending final response">Review final answer</button>
      <button data-action="viewResponses" title="Read a saved response without sending a new request">Saved responses</button>
      <button data-action="exportReport" title="Export this job's accounting without prompts or model output">Export report</button>
    </div>
    </details>
  </nav>
  <main>
    <div id="status" aria-live="polite"></div>
    <div id="job"></div>
    <div id="repair"></div>
  </main>
  <script nonce="${scriptNonce}">${script}</script>
</body>
</html>`;
}

export function emptyJobHtml(message: string): string {
  return `<section class="section">
    <p class="section-label">Active job</p>
    <p class="empty">${escapeHtml(message)}</p>
  </section>`;
}

export function jobSectionHtml(job: JobView): string {
  const band = riskBand(job);
  const controls = jobControls(job);
  const budget = Math.max(1, job.policy.budget_micro_usd);
  const settledPercent = Math.min(
    100,
    (job.accounting.settled_micro_usd / budget) * 100
  );
  const reservedPercent = Math.min(
    100 - settledPercent,
    (job.accounting.reserved_micro_usd / budget) * 100
  );
  const bandClass = `risk-${band.toLowerCase().replace("_", "-")}`;
  const visibleRequests = job.requests.slice(-MAX_VISIBLE_REQUESTS).reverse();
  const hiddenRequestCount = job.requests.length - visibleRequests.length;

  const requestRows = visibleRequests
    .map((request) => {
      const tone = requestStatusTone(request.status);
      return `<li class="request">
        <div class="request-head">
          <span class="request-sequence">#${request.sequence}</span>
          <span class="request-phase">${escapeHtml(request.phase)}</span>
          <span class="request-status tone-${tone}">${escapeHtml(request.status)}</span>
        </div>
        <code title="${escapeHtml(request.request_id)}">${escapeHtml(request.request_id)}</code>
      </li>`;
    })
    .join("");

  const finalState =
    job.pending_final_validation_request_id ??
    (job.completion_accepted === true
      ? "accepted"
      : job.completion_accepted === false
        ? "rejected"
        : "none");

  return `<section class="section">
    <div class="section-heading">
      <div>
        <p class="section-label">Active job</p>
        <h2><code title="${escapeHtml(job.id)}">${escapeHtml(job.id)}</code></h2>
        <p class="sub">${escapeHtml(job.status)} &middot; ${job.accounting.responses_started}/${job.policy.max_responses} responses</p>
      </div>
      <span class="risk ${bandClass}">${band.replace("_", " ")}</span>
    </div>

    <p class="banner ${job.status === "reconciliation_required" ? "bad" : "info"}">${escapeHtml(controls.message)}</p>

    <div class="budget-summary">
      <div class="budget-amount">$${escapeHtml(job.accounting.committed_usd)}</div>
      <div class="budget-caption">committed of $${escapeHtml(job.policy.budget_usd)}</div>
      <div class="budget-bar" role="img" aria-label="$${escapeHtml(job.accounting.settled_usd)} settled and $${escapeHtml(job.accounting.reserved_usd)} reserved">
        <span class="settled" style="width:${settledPercent.toFixed(2)}%"></span>
        <span class="reserved" style="width:${reservedPercent.toFixed(2)}%"></span>
      </div>
      <div class="legend" aria-hidden="true">
        <span><i class="settled"></i>Settled</span>
        <span><i class="reserved"></i>Reserved</span>
      </div>
    </div>

    <dl class="metrics">
      <div class="metric"><dt>Settled</dt><dd>$${escapeHtml(job.accounting.settled_usd)}</dd></div>
      <div class="metric"><dt>Reserved</dt><dd>$${escapeHtml(job.accounting.reserved_usd)}</dd></div>
      <div class="metric"><dt>Available</dt><dd>$${escapeHtml(job.accounting.available_for_work_usd)}</dd></div>
      <div class="metric"><dt>Final reserve</dt><dd>$${escapeHtml(job.policy.final_reserve_usd)}</dd></div>
      <div class="metric"><dt>Uncommitted</dt><dd>$${escapeHtml(job.accounting.uncommitted_usd)}</dd></div>
      <div class="metric"><dt>Final validation</dt><dd title="${escapeHtml(finalState)}">${escapeHtml(finalState)}</dd></div>
    </dl>

    <h3>Recent requests</h3>
    ${
      requestRows
        ? `<ul class="request-list">${requestRows}</ul>${
            hiddenRequestCount > 0
              ? `<p class="empty">${hiddenRequestCount} older request${hiddenRequestCount === 1 ? "" : "s"} hidden.</p>`
              : ""
          }`
        : '<p class="empty">No responses submitted.</p>'
    }
  </section>`;
}

function check(label: string, ok: boolean): string {
  return `<span class="check ${ok ? "tone-ok" : "tone-bad"}">${escapeHtml(label)}: ${ok ? "Pass" : "Fail"}</span>`;
}

export function repairSectionHtml(run: RepairRunResponse): string {
  const result = run.result;
  const repaired = result.status === "repaired";
  const scripted = run.mode !== "live";
  const evaluation = result.evaluation;
  const checks = evaluation
    ? [
        check("Tests", evaluation.targetPassed),
        check("File policy", evaluation.policyRespected),
        `<span class="check neutral">Exit ${evaluation.exitCode}</span>`,
        `<span class="check neutral">${result.toolCalls} tool calls</span>`
      ].join("")
    : '<span class="check neutral">No sealed evaluation</span>';

  const violations =
    evaluation && evaluation.violations.length > 0
      ? `<div class="banner bad">Policy violations: ${escapeHtml(evaluation.violations.join(", "))}</div>`
      : "";

  const trace = result.trace.length
    ? `<ol class="trace">${result.trace
        .map((event) => {
          const detail = [event.name, event.phase, event.status, event.state]
            .filter((part): part is string => Boolean(part))
            .join(" / ");
          return `<li>
            <span class="trace-sequence">#${event.sequence}</span>
            <span class="trace-kind">${escapeHtml(event.kind)}</span>
            <span class="trace-detail">${escapeHtml(detail)}</span>
          </li>`;
        })
        .join("")}</ol>`
    : '<p class="empty">No trace events.</p>';

  const finalText = result.finalText
    ? `<details open><summary>Repair summary</summary><pre>${escapeHtml(result.finalText)}</pre></details>`
    : "";

  return `<section class="section">
    <p class="section-label">${scripted ? "Last scripted sample" : "Last bundled repair"}</p>
    <div class="repair-card ${repaired ? "repaired" : "failed"}">
      <div class="repair-head">
        <span class="verdict ${repaired ? "" : "tone-bad"}">${scripted ? (repaired ? "Sample passed" : "Sample failed") : (repaired ? "Tests passed" : "Not repaired")}</span>
        <span class="spend"><span class="cost-label">${scripted ? "Simulated cost" : "Model cost"}</span> ${escapeHtml(formatMicroUsd(result.settledMicroUsd))}</span>
      </div>
      ${scripted ? `<p class="sample-note">${run.mode === "fake" ? "Scripted patch and usage. No model call or charge." : "Scripted patch and usage with live token counting. No model-generated repair."}</p>` : ""}
      <p class="sub">${escapeHtml(run.fixtureId)}${scripted ? "" : ` &middot; ${escapeHtml(run.model || "n/a")}`}${result.reason ? ` &middot; ${escapeHtml(result.reason)}` : ""}</p>
      <div class="checks">${checks}</div>
      ${violations}
      ${finalText}
      <details><summary>Execution log (${result.trace.length})</summary>${trace}</details>
    </div>
  </section>`;
}
