import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { jobControls, parseJobView } from "./jobModel";
import {
  emptyJobHtml,
  escapeHtml,
  isPanelAction,
  jobSectionHtml,
  repairSectionHtml,
  shellHtml,
  type RenderMessage
} from "./panelView";
import type { RepairRunResponse } from "./repairClient";

function renderedJob() {
  return parseJobView({
    id: 'job-<script>"',
    status: "open",
    policy: {
      budget_micro_usd: 100_000,
      budget_usd: "0.100000",
      final_reserve_micro_usd: 20_000,
      final_reserve_usd: "0.020000",
      max_responses: 12
    },
    accounting: {
      settled_micro_usd: 25_000,
      settled_usd: "0.025000",
      reserved_micro_usd: 10_000,
      reserved_usd: "0.010000",
      committed_micro_usd: 35_000,
      committed_usd: "0.035000",
      uncommitted_micro_usd: 65_000,
      uncommitted_usd: "0.065000",
      available_for_work_usd: "0.045000",
      responses_started: 10
    },
    pending_final_validation_request_id: null,
    completion_accepted: null,
    requests: Array.from({ length: 10 }, (_, index) => ({
      sequence: index + 1,
      request_id: `work:<${index + 1}>`,
      request_fingerprint: "a".repeat(64),
      phase: "work",
      status: index === 9 ? "pending" : "settled",
      started_at: "2026-07-18T15:00:00.000Z"
    }))
  });
}

function panelHarness() {
  const element = () => ({
    textContent: "", title: "", innerHTML: "", className: "", hidden: false, disabled: false, open: false,
    classList: { add: (_value: string) => {}, toggle: (_value: string, _enabled: boolean) => {} },
    setAttribute: (_name: string, _value: string) => {}
  });
  const actions = ["repairWorkspace", "reviewWorkspaceRepair", "runRepair", "sendPrompt", "createJob", "setActiveJob", "submitSelection", "finalize", "viewResponses", "exportReport"];
  const clicks = new Map<string, () => void>();
  const buttons = actions.map((action) => ({
    ...element(),
    getAttribute: () => action,
    addEventListener: (_event: string, handler: () => void) => { clicks.set(action, handler); }
  }));
  const nodes = new Map<string, ReturnType<typeof element>>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id)!;
  };
  const messages: unknown[] = [];
  let receive = (_event: { data: RenderMessage & { type: string } }) => {};
  const script = shellHtml("vscode-webview://governor").match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Panel script is missing");
  runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message) }),
    document: { querySelectorAll: () => buttons, getElementById: node, body: element() },
    window: {
      addEventListener: (_event: string, handler: typeof receive) => { receive = handler; }
    }
  });
  return {
    render: (message: RenderMessage) => receive({ data: { type: "render", ...message } }),
    enabled: (action: string) => !buttons[actions.indexOf(action)].disabled,
    click: (action: string) => clicks.get(action)?.(),
    text: (id: string) => node(id).textContent,
    node,
    messages,
    actions
  };
}

describe("panel shell", () => {
  it("uses a nonce CSP and exposes the compact action set", () => {
    const html = shellHtml("vscode-webview://governor");

    expect(html).toContain("default-src 'none'");
    expect(html).toMatch(/script-src 'nonce-[^']+'/);
    expect(html.match(/data-action=/g)).toHaveLength(10);
    expect(html).toContain('data-action="runRepair"');
    expect(html).toContain('data-action="sendPrompt"');
    expect(html).toContain('data-action="viewResponses"');
    expect(html).toContain('data-action="exportReport"');
    expect(html).toContain(">Saved jobs</button>");
    expect(html).toContain("aria-busy");
    expect(html).not.toContain("body.busy { opacity");
  });

  it("accepts only registered panel actions", () => {
    expect(isPanelAction("runRepair")).toBe(true);
    expect(isPanelAction("viewResponses")).toBe(true);
    expect(isPanelAction("exportReport")).toBe(true);
    expect(isPanelAction("refresh")).toBe(false);
    expect(isPanelAction({ action: "runRepair" })).toBe(false);
  });

  it("allows saved jobs and receipts without an API key, while fake repair does not unlock prompts", () => {
    const panel = panelHarness();
    expect(panel.actions.every((action) => !panel.enabled(action))).toBe(true);
    panel.render({
      connected: true, providerMode: "fake", providerConfigured: false,
      jobControls: jobControls(renderedJob())
    });
    expect(panel.enabled("setActiveJob")).toBe(true);
    expect(panel.enabled("viewResponses")).toBe(true);
    expect(panel.enabled("createJob")).toBe(true);
    expect(panel.enabled("runRepair")).toBe(true);
    expect(panel.enabled("repairWorkspace")).toBe(false);
    expect(panel.enabled("reviewWorkspaceRepair")).toBe(true);
    expect(panel.enabled("sendPrompt")).toBe(false);
    expect(panel.enabled("submitSelection")).toBe(false);
    expect(panel.text("action-hint")).toContain("API key");
    panel.click("sendPrompt");
    expect(panel.messages).toHaveLength(1);
    panel.click("viewResponses");
    expect(panel.messages.at(-1)).toEqual({ type: "action", action: "viewResponses" });
    panel.render({ providerMode: "live" });
    expect(panel.enabled("runRepair")).toBe(true);
    panel.render({ providerConfigured: true });
    expect(panel.enabled("repairWorkspace")).toBe(true);
    expect(panel.enabled("sendPrompt")).toBe(true);
    expect(panel.enabled("submitSelection")).toBe(true);
    expect(panel.enabled("runRepair")).toBe(true);
  });

  it("recomputes permissions after busy and connection updates instead of enabling every button", () => {
    const panel = panelHarness();
    const job = renderedJob();
    job.status = "reconciliation_required";
    panel.render({ connected: true, providerMode: "live", providerConfigured: true, jobControls: jobControls(job) });
    panel.render({ busy: true, busyLabel: "Working" });
    expect(panel.actions.every((action) => !panel.enabled(action))).toBe(true);
    panel.render({ busy: false });
    expect(panel.enabled("sendPrompt")).toBe(false);
    expect(panel.enabled("finalize")).toBe(false);
    expect(panel.enabled("viewResponses")).toBe(true);
    panel.render({ connected: false });
    panel.render({ busy: false, statusHtml: "Offline" });
    expect(panel.actions.every((action) => !panel.enabled(action))).toBe(true);
    panel.render({ connected: true, jobControls: jobControls(null) });
    expect(panel.enabled("sendPrompt")).toBe(false);
    expect(panel.enabled("viewResponses")).toBe(false);
    expect(panel.enabled("setActiveJob")).toBe(true);
  });

  it("allows final validation without a key only after the pending receipt is ready", () => {
    const panel = panelHarness();
    const job = renderedJob();
    job.status = "validation_required";
    job.pending_final_validation_request_id = "final:1";
    job.requests.at(-1)!.request_id = "final:1";
    job.requests.at(-1)!.phase = "final";
    job.requests.at(-1)!.status = "in_progress";
    panel.render({ connected: true, providerConfigured: false, jobControls: jobControls(job) });
    expect(panel.enabled("finalize")).toBe(false);
    job.requests.at(-1)!.status = "settled";
    panel.render({ jobControls: jobControls(job) });
    expect(panel.enabled("finalize")).toBe(true);
    expect(panel.enabled("sendPrompt")).toBe(false);
    expect(panel.enabled("viewResponses")).toBe(true);
  });

  it("allows report export for a closed job without a provider key", () => {
    const panel = panelHarness();
    const job = renderedJob();
    job.status = "completed";
    panel.render({ connected: true, providerConfigured: false, hasActiveJob: true, jobControls: jobControls(job) });
    expect(panel.enabled("exportReport")).toBe(true);
    expect(panel.enabled("sendPrompt")).toBe(false);
    panel.render({ hasActiveJob: false });
    expect(panel.enabled("exportReport")).toBe(false);
    panel.render({ hasActiveJob: true, connected: false });
    expect(panel.enabled("exportReport")).toBe(false);
  });

  it("explains the sample before a job exists and reveals prompt controls when selecting a job", () => {
    const panel = panelHarness();
    panel.render({ connected: true, providerConfigured: false, hasActiveJob: false });
    expect(panel.text("action-hint")).toContain("without a model or API key");
    expect(panel.enabled("runRepair")).toBe(true);
    expect(panel.enabled("repairWorkspace")).toBe(false);
    expect(panel.node("job").hidden).toBe(true);
    expect(panel.node("prompt-controls").open).toBe(false);
    panel.render({ hasActiveJob: true });
    expect(panel.node("job").hidden).toBe(false);
    expect(panel.node("prompt-controls").open).toBe(true);
    panel.node("prompt-controls").open = false;
    panel.render({ hasActiveJob: true });
    expect(panel.node("prompt-controls").open).toBe(false);
  });
});

describe("panel rendering", () => {
  it("escapes dynamic text and limits long request histories", () => {
    const html = jobSectionHtml(renderedJob());

    expect(html).toContain("job-&lt;script&gt;&quot;");
    expect(html).not.toContain('job-<script>"');
    expect(html.match(/class="request"/g)).toHaveLength(8);
    expect(html).toContain("2 older requests hidden.");
    expect(html).toContain("risk-safe");
  });

  it("does not present unresolved or stopped requests as successful", () => {
    const job = renderedJob();
    job.requests.at(-1)!.status = "unresolved";
    job.requests.at(-2)!.status = "provider_stopped";

    const html = jobSectionHtml(job);

    expect(html).toContain(
      'class="request-status tone-warn">unresolved</span>'
    );
    expect(html).toContain(
      'class="request-status tone-bad">provider_stopped</span>'
    );
    expect(html).toContain("Spending is blocked");
    expect(html).not.toContain("risk-safe");
  });

  it.each([
    ["completed", "This job is complete"],
    ["rejected", "this job is closed"],
    ["response_in_flight", "Wait for the current request"],
    ["reconciliation_required", "reservation is still held"],
    ["unrecognized", "not ready for new requests"]
  ])("shows the next step for %s jobs", (status, message) => {
    const job = renderedJob();
    job.status = status;
    expect(jobSectionHtml(job)).toContain(message);
  });

  it("escapes empty-state messages", () => {
    expect(emptyJobHtml("<no job>")).toContain("&lt;no job&gt;");
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("renders a repair result without trusting provider output", () => {
    const run: RepairRunResponse = {
      fixtureId: "broken-<sum>",
      mode: "fake",
      model: "test-model",
      rateCardVersion: "test",
      policy: {},
      result: {
        status: "repaired",
        finalText: "<script>alert(1)</script>",
        evaluation: {
          passed: true,
          targetPassed: true,
          policyRespected: true,
          exitCode: 0,
          violations: []
        },
        toolCalls: 2,
        revision: "rev-1",
        settledMicroUsd: 100,
        trace: [{ kind: "tool", sequence: 1, name: "<read_file>" }]
      }
    };

    const html = repairSectionHtml(run);
    expect(html).toContain("broken-&lt;sum&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Tests: Pass");
    expect(html).toContain("Last scripted sample");
    expect(html).toContain("Simulated cost");
    expect(html).toContain("No model call or charge");
    expect(html).not.toContain("test-model");

    const hybrid = repairSectionHtml({ ...run, mode: "hybrid" });
    expect(hybrid).toContain("live token counting");
    expect(hybrid).toContain("Simulated cost");
    expect(hybrid).not.toContain("No model call or charge");

    const live = repairSectionHtml({ ...run, mode: "live" });
    expect(live).toContain("Model cost");
    expect(live).toContain("test-model");
    expect(live).not.toContain("Simulated cost");
    expect(live).not.toContain("No model call or charge");
  });
});
