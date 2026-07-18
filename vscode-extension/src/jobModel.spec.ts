import { describe, expect, it } from "vitest";

import {
  collectOutputText,
  parseJobView,
  parseSubmission,
  promptResultMarkdown,
  riskBand
} from "./jobModel";

function jobPayload(committedMicroUsd = 15_000): Record<string, unknown> {
  return {
    id: "job-207",
    status: "active",
    policy: {
      budget_micro_usd: 100_000,
      budget_usd: "0.100000",
      final_reserve_micro_usd: 20_000,
      final_reserve_usd: "0.020000",
      max_responses: 8
    },
    accounting: {
      settled_micro_usd: 10_000,
      settled_usd: "0.010000",
      reserved_micro_usd: 5_000,
      reserved_usd: "0.005000",
      committed_micro_usd: committedMicroUsd,
      committed_usd: (committedMicroUsd / 1_000_000).toFixed(6),
      uncommitted_micro_usd: 100_000 - committedMicroUsd,
      uncommitted_usd: ((100_000 - committedMicroUsd) / 1_000_000).toFixed(6),
      available_for_work_usd: "0.065000",
      responses_started: 1
    },
    pending_final_validation_request_id: null,
    completion_accepted: null,
    requests: [
      {
        sequence: 1,
        request_id: "work:1",
        phase: "work",
        status: "settled",
        started_at: "2026-07-18T15:00:00.000Z"
      }
    ]
  };
}

describe("parseJobView", () => {
  it("normalizes a complete job response", () => {
    const job = parseJobView(jobPayload());

    expect(job.id).toBe("job-207");
    expect(job.accounting.committed_micro_usd).toBe(15_000);
    expect(job.requests[0]).toMatchObject({
      sequence: 1,
      phase: "work",
      status: "settled"
    });
  });

  it.each([
    ["negative accounting", "accounting", "settled_micro_usd", -1],
    ["fractional response count", "accounting", "responses_started", 1.5],
    ["invalid max responses", "policy", "max_responses", Number.NaN]
  ])("rejects %s", (_label, section, field, value) => {
    const payload = jobPayload() as Record<string, Record<string, unknown>>;
    payload[section][field] = value;

    expect(() => parseJobView(payload)).toThrowError(
      expect.objectContaining({ code: "INVALID_RESPONSE" })
    );
  });

  it("rejects unknown request phases", () => {
    const payload = jobPayload();
    (payload.requests as Array<Record<string, unknown>>)[0].phase = "draft";

    expect(() => parseJobView(payload)).toThrowError(
      expect.objectContaining({ code: "INVALID_RESPONSE" })
    );
  });
});

describe("riskBand", () => {
  it("uses the shared committed-budget thresholds", () => {
    expect(riskBand(parseJobView(jobPayload(69_999)))).toBe("SAFE");
    expect(riskBand(parseJobView(jobPayload(70_000)))).toBe("WATCH");
    expect(riskBand(parseJobView(jobPayload(90_000)))).toBe("AT_RISK");
  });
});

describe("parseSubmission", () => {
  it("parses provider output, usage, and reservation data", () => {
    const submission = parseSubmission({
      execution: {
        status: "settled",
        response: {
          model: "gpt-test",
          status: "completed",
          output: [
            {
              content: [
                { type: "output_text", text: "Fixed." },
                { type: "tool_call", name: "ignored" }
              ]
            }
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            total_tokens: 14
          }
        },
        reservation: {
          exact_input_tokens: 10,
          max_output_tokens: 100,
          reserved_usd: "0.002000",
          settled_usd: "0.000400"
        }
      },
      job: jobPayload()
    });

    expect(submission.execution.response?.usage?.total_tokens).toBe(14);
    expect(submission.execution.reservation?.settled_usd).toBe("0.000400");
    expect(collectOutputText(submission.execution.response?.output ?? [])).toBe(
      "Fixed."
    );
  });

  it("rejects fractional token counts", () => {
    expect(() =>
      parseSubmission({
        execution: {
          status: "settled",
          response: {
            model: "gpt-test",
            status: "completed",
            output: [],
            usage: {
              input_tokens: 1.2,
              output_tokens: 2,
              total_tokens: 3
            }
          }
        },
        job: jobPayload()
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_RESPONSE" }));
  });
});

describe("promptResultMarkdown", () => {
  it("renders the response text and accounting summary", () => {
    const submission = parseSubmission({
      execution: {
        status: "settled",
        response: {
          model: "gpt-test",
          status: "completed",
          output: [{ content: [{ type: "output_text", text: "Answer" }] }],
          usage: {
            input_tokens: 2,
            output_tokens: 1,
            total_tokens: 3
          }
        },
        reservation: {
          exact_input_tokens: 2,
          max_output_tokens: 10,
          reserved_usd: "0.001000",
          settled_usd: "0.000100"
        }
      },
      job: jobPayload()
    });

    const markdown = promptResultMarkdown(
      "job-207",
      "work:1",
      "work",
      "Question",
      submission
    );

    expect(markdown).toContain("- Tokens: 2 in / 1 out");
    expect(markdown).toContain("- Reserved: $0.001000, settled: $0.000100");
    expect(markdown).toContain("## Answer\n\nAnswer");
  });
});
