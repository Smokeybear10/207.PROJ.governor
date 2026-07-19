import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.js";
import { GovernedJobService } from "../server/jobs/index.js";
import type { JobStore } from "../server/jobs/store.js";
import type { GovernedResponseRequest, TerminalResponse } from "../server/openai/index.js";
import type { ResponsesProvider } from "../server/runtime/index.js";

const NOW = new Date("2026-11-06T16:00:00.000Z");
const JOB = "job_report";
const servers: Server[] = [];

function provider(): ResponsesProvider {
  let sequence = 0;
  return {
    countInput: vi.fn(async () => 100),
    createResponse: vi.fn(async (request: GovernedResponseRequest): Promise<TerminalResponse> => ({
      id: `resp_${++sequence}`, model: request.model, serviceTier: "default", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "PRIVATE_OUTPUT_MARKER" }] }],
      usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0,
        outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 120 }
    }))
  };
}

function memoryStore(): JobStore {
  const records = new Map<string, unknown>();
  return {
    assertAvailable() {},
    load: () => [...records.values()].map((value) => structuredClone(value)),
    save: vi.fn((id, value) => { records.set(id, structuredClone(value)); })
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("governed spending reports", () => {
  it("exports accounting and pricing without prompts, instructions, or model output", async () => {
    const store = memoryStore();
    const model = provider();
    const jobs = new GovernedJobService({ store, provider: model, idFactory: () => JOB, now: () => NOW });
    jobs.createJob({ budget_usd: "0.075" });
    for (const phase of ["work", "final"] as const) {
      await jobs.createResponse(JOB, { request_id: phase, phase, input: "PRIVATE_PROMPT_MARKER",
        instructions: "PRIVATE_INSTRUCTIONS_MARKER" });
    }
    jobs.finalizeJob(JOB, { request_id: "final", accepted: true });
    const before = jobs.getJob(JOB);
    const saved = vi.mocked(store.save).mock.calls.length;
    const report = jobs.getReport(JOB);

    expect(report).toMatchObject({
      object: "token_governor.report", schema_version: 1, content_included: false,
      generated_at: NOW.toISOString(),
      job: { id: JOB, status: "completed", completion_accepted: true,
        pricing: { provider: "openai", model: "gpt-5.4-mini" },
        accounting: { settled_micro_usd: 330, reserved_micro_usd: 0 } },
      requests: [
        { sequence: 1, request_id: "work", phase: "work", status: "settled",
          provider_response_id: "resp_1", outcome_code: null, reason: null,
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          reservation: { settled_usd: "0.000165", exact_input_tokens: 100,
            protected_final_reserve_usd: "0.015000" } },
        { sequence: 2, request_id: "final", phase: "final", status: "settled",
          provider_response_id: "resp_2", reservation: { protected_final_reserve_usd: "0.000000" } }
      ]
    });
    const json = JSON.stringify(report);
    expect(json).not.toContain("PRIVATE_");
    expect(report.requests[0].request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(vi.mocked(model.createResponse)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(store.save)).toHaveBeenCalledTimes(saved);
    expect(jobs.getJob(JOB)).toEqual(before);

    const reopened = new GovernedJobService({ store, now: () => NOW });
    expect(reopened.getReport(JOB)).toEqual(report);
  });

  it("reports a running request without waiting and retains ambiguous reservations", async () => {
    let start!: () => void;
    let fail!: (reason: Error) => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const pending = new Promise<TerminalResponse>((_resolve, reject) => { fail = reject; });
    const model: ResponsesProvider = {
      countInput: async () => 100,
      createResponse: async () => { start(); return pending; }
    };
    const jobs = new GovernedJobService({ provider: model, idFactory: () => JOB });
    jobs.createJob({ budget_usd: "0.075" });
    const attempt = jobs.createResponse(JOB, { request_id: "work", phase: "work", input: "secret" });
    await started;
    expect(jobs.getReport(JOB)).toMatchObject({
      job: { status: "response_in_flight" },
      requests: [{ status: "in_progress", usage: null, reservation: { status: "in_flight", settled_usd: null } }]
    });
    fail(new Error("private provider error details"));
    await attempt;
    const report = jobs.getReport(JOB);
    expect(report).toMatchObject({
      job: { status: "reconciliation_required" },
      requests: [{ status: "unresolved", reason: "transport_error", usage: null,
        reservation: { status: "ambiguous", settled_usd: null } }]
    });
    expect(JSON.stringify(report)).not.toContain("private provider error details");
  });

  it("includes denials without inventing charges or provider response IDs", async () => {
    const model = provider();
    vi.mocked(model.countInput).mockResolvedValue(1_000_000);
    const jobs = new GovernedJobService({ provider: model, idFactory: () => JOB });
    jobs.createJob({ budget_usd: "0.075" });
    await expect(jobs.createResponse(JOB, { request_id: "denied", phase: "work", input: "large" }))
      .rejects.toMatchObject({ code: "GOVERNOR_DENIED" });
    expect(jobs.getReport(JOB)).toMatchObject({ requests: [{ status: "denied",
      outcome_code: "GOVERNOR_DENIED", reason: "INPUT_EXCEEDS_AVAILABLE_BUDGET",
      reservation: null, usage: null, provider_response_id: null }] });
    expect(model.createResponse).not.toHaveBeenCalled();
  });

  it("serves a private no-store report without a key and preserves local API restrictions", async () => {
    const start = async (exposeGovernedApi = true): Promise<string> => {
      const server = createApp({ provider: null, jobIdFactory: () => JOB, exposeGovernedApi }).listen(0, "127.0.0.1");
      servers.push(server);
      await once(server, "listening");
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const base = await start();
    await fetch(`${base}/v1/jobs`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ budget_usd: "0.075" }) });
    const report = await fetch(`${base}/v1/jobs/${JOB}/report`);
    expect(report.status).toBe(200);
    expect(report.headers.get("Cache-Control")).toBe("no-store");
    expect(await report.json()).toMatchObject({ object: "token_governor.report", content_included: false, requests: [] });
    expect((await fetch(`${base}/v1/jobs/${JOB}/report`, { headers: { Origin: "https://other.test" } })).status).toBe(403);
    expect((await fetch(`${base}/v1/jobs/missing/report`)).status).toBe(404);
    expect((await fetch(`${await start(false)}/v1/jobs/${JOB}/report`)).status).toBe(404);
  });
});
