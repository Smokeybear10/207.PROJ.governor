import { describe, expect, it } from "vitest";

import { parseJobView } from "./jobModel";
import {
  emptyJobHtml,
  escapeHtml,
  isPanelAction,
  jobSectionHtml,
  repairSectionHtml,
  shellHtml
} from "./panelView";
import type { RepairRunResponse } from "./repairClient";

function renderedJob() {
  return parseJobView({
    id: 'job-<script>"',
    status: "active",
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
      phase: "work",
      status: index === 9 ? "pending" : "settled",
      started_at: "2026-07-18T15:00:00.000Z"
    }))
  });
}

describe("panel shell", () => {
  it("uses a nonce CSP and exposes the compact action set", () => {
    const html = shellHtml("vscode-webview://governor");

    expect(html).toContain("default-src 'none'");
    expect(html).toMatch(/script-src 'nonce-[^']+'/);
    expect(html.match(/data-action=/g)).toHaveLength(6);
    expect(html).toContain('data-action="runRepair"');
    expect(html).toContain('data-action="sendPrompt"');
    expect(html).toContain("aria-busy");
    expect(html).not.toContain("body.busy { opacity");
  });

  it("accepts only registered panel actions", () => {
    expect(isPanelAction("runRepair")).toBe(true);
    expect(isPanelAction("refresh")).toBe(false);
    expect(isPanelAction({ action: "runRepair" })).toBe(false);
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
    expect(html).toContain("Evaluation: Pass");
  });
});
