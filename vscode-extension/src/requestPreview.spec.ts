import { describe, expect, it } from "vitest";
import { confirmedRequestBody, parseRequestQuote, quoteDetail } from "./requestPreview";

function payload() {
  return {
    object: "token_governor.quote", job_id: "job_preview", quoted_at: "2026-11-06T12:00:00.000Z",
    phase: "work", model: "gpt-5.4-mini", rate_card_version: "pinned-rate-card", context_sha256: "a".repeat(64),
    admitted: true, reason: null, exact_input_tokens: 100, requested_max_output_tokens: 768,
    max_output_tokens: 200, minimum_output_tokens: 64,
    max_cost_micro_usd: 977, max_cost_usd: "0.000977", input_cost_usd: "0.000077",
    output_cost_usd: "0.000900", protected_final_reserve_usd: "0.015000", available_after_usd: "0.059023"
  };
}

describe("cost preview", () => {
  it("parses the quote and sends only its approved cap with the captured input", () => {
    const quote = parseRequestQuote(payload());
    expect(confirmedRequestBody(quote, "work:1", "Original selection")).toEqual({
      request_id: "work:1", phase: "work", input: "Original selection", model: "gpt-5.4-mini",
      max_output_tokens: 200, minimum_output_tokens: 64, max_cost_usd: "0.000977"
    });
    expect(quoteDetail(quote)).toContain("100 tokens");
    expect(quoteDetail(quote)).toContain("reduced from 768 to fit");
    expect(quoteDetail(quote)).toContain("$0.015000");
    expect(quoteDetail(quote)).toContain("no response has been generated or budget reserved");
    expect(quoteDetail(quote)).toContain("not a provider invoice");
  });

  it("accepts a denied final preview below the protected minimum and never builds a send body", () => {
    const quote = parseRequestQuote({
      ...payload(), phase: "final", admitted: false, reason: "OUTPUT_BELOW_MINIMUM",
      requested_max_output_tokens: 100, max_output_tokens: 100, minimum_output_tokens: 256,
      max_cost_micro_usd: null, max_cost_usd: null, output_cost_usd: null, available_after_usd: null
    });
    expect(quoteDetail(quote)).toContain("cannot be sent");
    expect(() => confirmedRequestBody(quote, "final:1", "Prompt"))
      .toThrowError(expect.objectContaining({ code: "QUOTE_DENIED" }));
  });

  it.each([
    { object: "different" }, { admitted: "yes" }, { job_id: "../job" },
    { phase: "draft" }, { context_sha256: "not-a-hash" }, { quoted_at: "yesterday" },
    { exact_input_tokens: 1.5 }, { max_output_tokens: 769 }, { minimum_output_tokens: 0 },
    { minimum_output_tokens: 256 }, { max_cost_usd: null },
    { max_cost_micro_usd: 0, max_cost_usd: "0.000000" },
    { max_cost_micro_usd: 978 }, { output_cost_usd: "-0.01" },
    { input_cost_usd: "0.000078" }, { admitted: false, reason: null }
  ])("rejects malformed or inconsistent previews: %j", (invalid) => {
    expect(() => parseRequestQuote({ ...payload(), ...invalid }))
      .toThrowError(expect.objectContaining({ code: "INVALID_RESPONSE" }));
  });
});
