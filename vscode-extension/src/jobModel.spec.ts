import { describe, expect, it, vi } from "vitest";

import {
  collectOutputText,
  jobControls,
  loadSavedResponse,
  parseJobList,
  parseJobView,
  parseSubmission,
  promptResultMarkdown,
  riskBand,
  savedResponseMarkdown
} from "./jobModel";

function jobPayload(committedMicroUsd = 15_000): Record<string, unknown> {
  return {
    id: "job-207",
    status: "open",
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
        request_fingerprint: "a".repeat(64),
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
      request_fingerprint: "a".repeat(64),
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

describe("parseJobList", () => {
  const summary = {
    id: "job-207",
    created_at: "2026-11-06T12:00:00.000Z",
    status: "open",
    budget_usd: "0.100000",
    settled_usd: "0.010000",
    reserved_usd: "0.000000",
    responses_started: 1,
    max_responses: 8
  };

  it("parses empty, complete, and paginated saved jobs", () => {
    expect(parseJobList({ object: "list", data: [], has_more: false, next_after: null }).data).toEqual([]);
    const payload = { object: "list", data: [summary], has_more: true, next_after: summary.id };
    expect(parseJobList(payload)).toEqual(payload);
    expect(parseJobList({ ...payload, has_more: false, next_after: null }).data).toEqual([summary]);
  });

  it.each([
    { object: "jobs" },
    { data: {} },
    { data: [summary, summary] },
    { has_more: "false" },
    { has_more: true, next_after: null },
    { has_more: true, next_after: "job-other" },
    { next_after: summary.id }
  ])("rejects invalid list envelopes: %j", (invalid) => {
    expect(() => parseJobList({ object: "list", data: [summary], has_more: false, next_after: null, ...invalid }))
      .toThrowError(expect.objectContaining({ code: "INVALID_RESPONSE" }));
  });

  it.each([
    { id: "../jobs" },
    { created_at: "2026-02-30T12:00:00.000Z" },
    { status: "" },
    { budget_usd: 0.1 },
    { settled_usd: "-0.01" },
    { reserved_usd: "NaN" },
    { responses_started: 1.5 },
    { responses_started: 9 },
    { max_responses: 0 }
  ])("rejects invalid summaries: %j", (invalid) => {
    expect(() => parseJobList({
      object: "list", data: [{ ...summary, ...invalid }], has_more: false, next_after: null
    })).toThrowError(expect.objectContaining({ code: "INVALID_RESPONSE" }));
  });
});

describe("jobControls", () => {
  it("requires an active job while allowing reads of existing receipts", () => {
    expect(jobControls(null)).toMatchObject({ canSubmit: false, canFinalize: false, canViewResponses: false });
    expect(jobControls(parseJobView(jobPayload()))).toMatchObject({
      canSubmit: true, canFinalize: false, canViewResponses: true
    });
  });

  it.each(["response_in_flight", "reconciliation_required", "completed", "rejected", "future_state"])(
    "blocks submissions for %s jobs", (status) => {
      const job = parseJobView(jobPayload());
      job.status = status;
      expect(jobControls(job)).toMatchObject({ canSubmit: false, canFinalize: false, canViewResponses: true });
    }
  );

  it.each(["open", "validation_required"])("waits for in-progress receipts even when job status is %s", (status) => {
    const job = parseJobView(jobPayload());
    job.status = status;
    job.pending_final_validation_request_id = status === "validation_required" ? "work:1" : null;
    job.requests[0].status = "in_progress";
    expect(jobControls(job)).toMatchObject({ canSubmit: false, canFinalize: false, canViewResponses: false });
    expect(jobControls(job).message).toContain("Wait for");
  });

  it("allows final validation only when the final receipt is ready", () => {
    const job = parseJobView(jobPayload());
    job.status = "validation_required";
    job.pending_final_validation_request_id = "final:1";
    expect(jobControls(job).canFinalize).toBe(false);
    job.requests[0].request_id = "final:1";
    job.requests[0].phase = "final";
    expect(jobControls(job)).toMatchObject({ canSubmit: false, canFinalize: true });
    job.pending_final_validation_request_id = null;
    expect(jobControls(job).canFinalize).toBe(false);
  });

  it("keeps the final response available in the last slot, then blocks at the limit", () => {
    const job = parseJobView(jobPayload());
    job.accounting.responses_started = 7;
    expect(jobControls(job).canSubmit).toBe(true);
    expect(jobControls(job).message).toContain("Only a final response");
    job.accounting.responses_started = 8;
    expect(jobControls(job).canSubmit).toBe(false);
    expect(jobControls(job).message).toContain("response limit");
  });

  it("permits protected final budget but blocks jobs with no uncommitted budget", () => {
    const job = parseJobView(jobPayload());
    job.accounting.available_for_work_usd = "0.000000";
    expect(jobControls(job).canSubmit).toBe(true);
    expect(jobControls(job).message).toContain("Only a final response");
    job.accounting.uncommitted_micro_usd = 0;
    expect(jobControls(job).canSubmit).toBe(false);
    expect(jobControls(job).message).toContain("no uncommitted budget");
  });
});

describe("riskBand", () => {
  it("uses the shared committed-budget thresholds", () => {
    expect(riskBand(parseJobView(jobPayload(69_999)))).toBe("SAFE");
    expect(riskBand(parseJobView(jobPayload(70_000)))).toBe("WATCH");
    expect(riskBand(parseJobView(jobPayload(90_000)))).toBe("AT_RISK");
  });

  it("does not label unresolved low-spend jobs safe", () => {
    const job = parseJobView(jobPayload(100));
    job.status = "reconciliation_required";
    expect(riskBand(job)).toBe("AT_RISK");
    job.status = "open";
    job.requests[0].status = "unresolved";
    expect(riskBand(job)).toBe("AT_RISK");
    expect(jobControls(job).canSubmit).toBe(false);
  });
});

describe("parseSubmission", () => {
  it("parses provider output, usage, and reservation data", () => {
    const submission = parseSubmission({ request_fingerprint: "a".repeat(64),
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
          request_id: "work:1", phase: "work",
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
      parseSubmission({ request_fingerprint: "a".repeat(64),
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

  it.each([undefined, "not-a-hash", "a".repeat(63)])("rejects missing or invalid intent fingerprints: %s", (fingerprint) => {
    const payload = jobPayload();
    (payload.requests as Array<Record<string, unknown>>)[0].request_fingerprint = fingerprint;
    expect(() => parseJobView(payload)).toThrowError(expect.objectContaining({ code: "INVALID_RESPONSE" }));
    expect(() => parseSubmission({ request_fingerprint: fingerprint, execution: { status: "denied" }, job: jobPayload() }))
      .toThrowError(expect.objectContaining({ code: "INVALID_RESPONSE" }));
  });
});

describe("promptResultMarkdown", () => {
  it("renders the response text and accounting summary", () => {
    const submission = parseSubmission({ request_fingerprint: "a".repeat(64),
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
          request_id: "work:1", phase: "work",
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

describe("loadSavedResponse", () => {
  it("reads a completed request from its original job without submitting again", async () => {
    const job = jobPayload();
    const read = vi.fn().mockResolvedValueOnce(job).mockResolvedValueOnce({
      request_fingerprint: "a".repeat(64),
      execution: { status: "settled" }, job
    });

    const saved = await loadSavedResponse("job-207", "work:1", read);

    expect(saved).toMatchObject({ status: "ready", request: { request_id: "work:1" } });
    expect(read.mock.calls).toEqual([
      ["/v1/jobs/job-207"],
      ["/v1/jobs/job-207/responses/work%3A1"]
    ]);
  });

  it("shows a running request without waiting on or resubmitting its receipt", async () => {
    const job = jobPayload();
    (job.requests as Array<Record<string, unknown>>)[0].status = "in_progress";
    const read = vi.fn().mockResolvedValue(job);

    await expect(loadSavedResponse("job-207", "work:1", read)).resolves.toMatchObject({
      status: "pending", message: expect.stringContaining("still running")
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not treat a missing attempt as permission to generate again", async () => {
    const read = vi.fn().mockResolvedValue(jobPayload());

    await expect(loadSavedResponse("job-207", "work:not-recorded", read)).resolves.toMatchObject({
      status: "missing", message: expect.stringContaining("before sending another request")
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps an unresolved outcome and held budget visible", async () => {
    const job = jobPayload();
    (job.requests as Array<Record<string, unknown>>)[0].status = "unresolved";
    const read = vi.fn().mockResolvedValueOnce(job).mockResolvedValueOnce({
      request_fingerprint: "a".repeat(64),
      execution: {
        status: "unresolved", reason: "transport_error",
        reservation: { request_id: "work:1", phase: "work", exact_input_tokens: 100, max_output_tokens: 200, reserved_usd: "0.001000", settled_usd: null }
      }, job
    });

    const saved = await loadSavedResponse("job-207", "work:1", read);
    expect(saved.status).toBe("ready");
    if (saved.status !== "ready") throw new Error("expected a saved receipt");
    const markdown = savedResponseMarkdown("job-207", saved.request, saved.submission);
    expect(markdown).toContain("reservation remains held");
    expect(markdown).toContain("Settlement: unresolved");
    expect(markdown).not.toContain("reported usage was settled");
  });

  it("rejects a different job before reading a receipt", async () => {
    const read = vi.fn().mockResolvedValue({ ...jobPayload(), id: "other-job" });

    await expect(loadSavedResponse("job-207", "work:1", read)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each(["job", "request", "phase", "status", "fingerprint"])("rejects saved receipt %s mismatches", async (field) => {
    const job = jobPayload();
    const changed = structuredClone(job);
    const request = (changed.requests as Array<Record<string, unknown>>)[0];
    if (field === "job") changed.id = "other-job";
    if (field === "request") request.request_id = "different-request";
    if (field === "phase") request.phase = "final";
    if (field === "status") request.status = "unresolved";
    if (field === "fingerprint") request.request_fingerprint = "b".repeat(64);
    const read = vi.fn().mockResolvedValueOnce(job).mockResolvedValueOnce({
      request_fingerprint: "a".repeat(64),
      execution: { status: "settled" }, job: changed
    });

    await expect(loadSavedResponse("job-207", "work:1", read)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects a different response from the same job with the same phase and status", async () => {
    const job = jobPayload();
    (job.requests as Array<Record<string, unknown>>).push({
      ...(job.requests as Array<Record<string, unknown>>)[0],
      sequence: 2, request_id: "work:2", request_fingerprint: "b".repeat(64)
    });
    const read = vi.fn().mockResolvedValueOnce(job).mockResolvedValueOnce({
      request_fingerprint: "b".repeat(64), execution: { status: "settled" }, job
    });

    await expect(loadSavedResponse("job-207", "work:1", read)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each(["request_id", "phase"])("rejects a reservation %s mismatch even for an identical intent", async (field) => {
    const job = jobPayload();
    const reservation = {
      request_id: "work:1", phase: "work", exact_input_tokens: 100, max_output_tokens: 200,
      reserved_usd: "0.001000", settled_usd: "0.000100"
    };
    reservation[field as "request_id" | "phase"] = field === "request_id" ? "work:2" : "final";
    const read = vi.fn().mockResolvedValueOnce(job).mockResolvedValueOnce({
      request_fingerprint: "a".repeat(64), execution: { status: "settled", reservation }, job
    });

    await expect(loadSavedResponse("job-207", "work:1", read)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("savedResponseMarkdown", () => {
  it("shows the saved output and metadata without inventing a prompt", () => {
    const submission = parseSubmission({ request_fingerprint: "a".repeat(64),
      execution: {
        status: "settled",
        response: {
          model: "gpt-test", status: "completed",
          output: [{ content: [{ type: "output_text", text: "Saved answer." }] }],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
        }
      },
      job: jobPayload()
    });
    const markdown = savedResponseMarkdown("job-207", submission.job.requests[0], submission);
    expect(markdown).toContain("## Output\n\nSaved answer.");
    expect(markdown).toContain("The original prompt is not stored");
    expect(markdown).not.toContain("## Prompt");
    expect(markdown).toContain("- Tokens: 10 in / 2 out");
  });

  it.each([
    ["denied", "blocked this request before dispatch"],
    ["preflight_failed", "Preflight failed before dispatch"],
    ["provider_rejected", "provider rejected this request"],
    ["provider_stopped", "provider stopped before completing"],
    ["unresolved", "reservation remains held"]
  ])("describes %s receipts accurately", (status, explanation) => {
    const submission = parseSubmission({ request_fingerprint: "a".repeat(64), execution: { status }, job: jobPayload() });
    const markdown = savedResponseMarkdown("job-207", submission.job.requests[0], submission);
    expect(markdown).toContain(explanation);
    expect(markdown).toContain("No provider output was saved");
    expect(markdown).not.toContain("## Answer");
  });

  it("escapes receipt metadata and preserves tool-only output inside a safe fence", () => {
    const submission = parseSubmission({ request_fingerprint: "a".repeat(64),
      execution: {
        status: "settled",
        response: { model: "<model>", status: "completed", output: [{ type: "function_call", arguments: "```injected" }] }
      },
      job: jobPayload()
    });
    const request = { ...submission.job.requests[0], request_id: "<request>" };
    const markdown = savedResponseMarkdown("<job>", request, submission);
    expect(markdown).toContain("\\<job\\>");
    expect(markdown).toContain("\\<request\\>");
    expect(markdown).toContain("\\<model\\>");
    expect(markdown).toContain("````json");
    expect(markdown).toContain('"type": "function_call"');
  });

  it("does not describe a released provider rejection as unresolved", () => {
    const submission = parseSubmission({ request_fingerprint: "a".repeat(64),
      execution: {
        status: "provider_rejected",
        reservation: { request_id: "work:1", phase: "work", exact_input_tokens: 100, max_output_tokens: 200, reserved_usd: "0.001000", settled_usd: null }
      },
      job: jobPayload()
    });
    const markdown = savedResponseMarkdown("job-207", submission.job.requests[0], submission);
    expect(markdown).toContain("Settlement: no usage charge recorded");
    expect(markdown).not.toContain("Settlement: unresolved");
  });
});
