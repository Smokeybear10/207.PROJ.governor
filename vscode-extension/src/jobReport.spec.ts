import { describe, expect, it } from "vitest";
import { jobReportMarkdown, parseJobReport } from "./jobReport";

function payload(status = "settled") {
  const request = {
    sequence: 1, request_id: "work:1", phase: "work", status,
    started_at: "2026-11-06T12:00:00.000Z", request_fingerprint: "a".repeat(64)
  };
  return {
    object: "token_governor.report", schema_version: 1, generated_at: "2026-11-06T12:01:00.000Z", content_included: false,
    job: {
      id: "job_report", status: status === "unresolved" ? "reconciliation_required" : "open", created_at: "2026-11-06T12:00:00.000Z",
      policy: {
        budget_micro_usd: 75000, budget_usd: "0.075000", final_reserve_micro_usd: 15000,
        final_reserve_usd: "0.015000", max_responses: 4, final_input_token_limit: 8192, minimum_final_output_tokens: 256
      },
      accounting: {
        settled_micro_usd: 165, settled_usd: "0.000165", reserved_micro_usd: 0, reserved_usd: "0.000000",
        committed_micro_usd: 165, committed_usd: "0.000165", uncommitted_micro_usd: 74835, uncommitted_usd: "0.074835",
        available_for_work_usd: "0.059835", responses_started: 1
      },
      pricing: {
        provider: "openai", model: "gpt-5.4-mini", service_tier: "standard", request_service_tier: "default",
        processing_region: "global", rate_card_version: "pinned-card", rate_card_source: "https://example.com/pricing",
        rate_card_effective_at: "2026-11-06T00:00:00.000Z", rates_micro_usd_per_million_tokens: {
          uncachedInputMicroUsdPerMillionTokens: 750000, cachedInputMicroUsdPerMillionTokens: 75000,
          cacheWriteInputMicroUsdPerMillionTokens: 750000, outputMicroUsdPerMillionTokens: 4500000
        }
      },
      pending_final_validation_request_id: null, completion_accepted: null, requests: [request]
    },
    requests: [{
      ...request, outcome_code: null, reason: status === "unresolved" ? "service_restarted" : null,
      reservation: status === "in_progress" ? null : {
        request_id: "work:1", phase: "work", status: status === "unresolved" ? "ambiguous" : "settled",
        exact_input_tokens: 100, max_output_tokens: 200, reserved_micro_usd: 977, reserved_usd: "0.000977",
        settled_micro_usd: status === "unresolved" ? null : 165, settled_usd: status === "unresolved" ? null : "0.000165",
        protected_final_reserve_usd: "0.015000", context_sha256: "b".repeat(64), request_sha256: "c".repeat(64),
        terminal_reason: status === "unresolved" ? null : "provider_completed"
      },
      usage: status === "settled" ? {
        input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 120
      } : null,
      provider_response_id: status === "settled" ? "resp_1" : null
    }]
  };
}

describe("job report", () => {
  it("preserves pinned pricing and final policy, and renders the accounting history", () => {
    const report = parseJobReport(payload());
    expect(report.job.pricing.model).toBe("gpt-5.4-mini");
    expect(report.job.policy.final_input_token_limit).toBe(8192);
    expect(report.job.policy.minimum_final_output_tokens).toBe(256);
    expect(report.requests[0].reservation?.reserved_micro_usd).toBe(977);
    const markdown = jobReportMarkdown(report);
    expect(markdown).toContain("pinned-card");
    expect(markdown).toContain("| 1 | work:1 | work | settled | 100 | 200 | $0.000977 | $0.000165 |");
    expect(markdown).toContain("not a provider invoice or tamperproof proof");
  });

  it("whitelists metadata so unexpected prompts and model output cannot leak into exports", () => {
    const source = payload();
    const report = parseJobReport({
      ...source, input: "PRIVATE PROMPT", output: "PRIVATE OUTPUT",
      job: { ...source.job, input: "PRIVATE PROMPT" },
      requests: source.requests.map((request) => ({ ...request, output: "PRIVATE OUTPUT" }))
    });
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
    expect(jobReportMarkdown(report)).not.toContain("PRIVATE");
  });

  it.each([
    ["in_progress", "still running when the report was generated"],
    ["unresolved", "reservation remains held"]
  ])("renders %s snapshots without inventing a completed response", (status, message) => {
    const report = parseJobReport(payload(status));
    expect(jobReportMarkdown(report)).toContain(message);
    expect(jobReportMarkdown(report)).not.toContain("$null");
  });

  it("escapes report identifiers in headings and table cells", () => {
    const source = payload();
    source.job.id = "<job>";
    source.job.requests[0].request_id = "work:|<1>";
    source.requests[0].request_id = "work:|<1>";
    source.requests[0].reservation!.request_id = "work:|<1>";
    const markdown = jobReportMarkdown(parseJobReport(source));
    expect(markdown).toContain("\\<job\\>");
    expect(markdown).toContain("work:\\|\\<1\\>");
  });

  it.each([
    { schema_version: 2 }, { content_included: true }, { generated_at: "invalid" }, { requests: [] }
  ])("rejects inconsistent report envelopes: %j", (invalid) => {
    expect(() => parseJobReport({ ...payload(), ...invalid }))
      .toThrowError(expect.objectContaining({ code: "INVALID_RESPONSE" }));
  });
});
