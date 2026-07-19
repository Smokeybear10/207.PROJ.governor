import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.js";
import { GovernedJobService } from "../server/jobs/index.js";
import type { JobStore } from "../server/jobs/store.js";
import { prepareResponseContext, type ResponsesProvider } from "../server/runtime/index.js";
import type { GovernedResponseRequest, ResponseContext, TerminalResponse } from "../server/openai/index.js";

const JOB_ID = "job_quote";
const INPUT = { phase: "work", input: "Review this change.", max_output_tokens: 200, minimum_output_tokens: 32 };
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function provider() {
  let responseNumber = 0;
  return {
    countInput: vi.fn(async (_context: ResponseContext, _signal?: AbortSignal) => 100),
    createResponse: vi.fn(async (request: GovernedResponseRequest): Promise<TerminalResponse> => ({
      id: `resp_quote_${++responseNumber}`,
      model: request.model,
      serviceTier: "default",
      status: "completed",
      output: [],
      usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 120 }
    }))
  };
}

function setup(options: { provider?: ResponsesProvider; job?: Record<string, unknown> } = {}) {
  const values = new Map<string, unknown>();
  const store = {
    assertAvailable: vi.fn(),
    load: () => [...values.values()],
    save: vi.fn((id: string, value: unknown) => { values.set(id, structuredClone(value)); })
  } satisfies JobStore;
  const mockProvider = options.provider ?? provider();
  const jobs = new GovernedJobService({ provider: mockProvider, store, idFactory: () => JOB_ID, now: () => new Date("2026-11-06T12:00:00.000Z") });
  jobs.createJob(options.job ?? { budget_usd: "0.075" });
  store.save.mockClear();
  return { jobs, store, values, provider: mockProvider };
}

describe("exact governed request quotes", () => {
  it("counts exact input without generation, persistence, accounting or request-ID changes", async () => {
    const mock = provider();
    const { jobs, store, values } = setup({ provider: mock });
    const before = jobs.getJob(JOB_ID);
    const saved = structuredClone([...values.values()]);
    const quote = await jobs.quoteResponse(JOB_ID, INPUT);
    expect(quote).toMatchObject({
      object: "token_governor.quote", job_id: JOB_ID, quoted_at: "2026-11-06T12:00:00.000Z",
      admitted: true, reason: null, exact_input_tokens: 100,
      requested_max_output_tokens: 200, max_output_tokens: 200, minimum_output_tokens: 32,
      max_cost_micro_usd: 977, max_cost_usd: "0.000977", input_cost_usd: "0.000077",
      output_cost_usd: "0.000900", protected_final_reserve_usd: "0.015000", available_after_usd: "0.059023"
    });
    expect(quote.context_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(mock.countInput).toHaveBeenCalledTimes(1);
    expect(mock.createResponse).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(jobs.getJob(JOB_ID)).toEqual(before);
    expect([...values.values()]).toEqual(saved);
    await jobs.createResponse(JOB_ID, { ...INPUT, request_id: "work:1", max_cost_usd: quote.max_cost_usd });
    expect(mock.countInput).toHaveBeenCalledTimes(2);
    expect(mock.createResponse).toHaveBeenCalledTimes(1);
    expect(jobs.getJob(JOB_ID)).toMatchObject({ requests: [{ sequence: 1, request_id: "work:1" }] });
  });

  it("quotes a reduced cap when the remaining work budget is small", async () => {
    const { jobs } = setup({ job: {
      budget_usd: "0.000200", final_reserve_usd: "0.000100", final_input_token_limit: 1, minimum_final_output_tokens: 1
    } });
    const quote = await jobs.quoteResponse(JOB_ID, { ...INPUT, minimum_output_tokens: 1 });
    expect(quote).toMatchObject({ admitted: true, max_output_tokens: 5, max_cost_usd: "0.000100", available_after_usd: "0.000000" });
  });

  it("applies an optional caller ceiling to the same cloned admission", async () => {
    const mock = provider();
    const { jobs, store } = setup({ provider: mock });
    const before = jobs.getJob(JOB_ID);
    expect(await jobs.quoteResponse(JOB_ID, { ...INPUT, max_cost_usd: "0.000500" })).toMatchObject({
      admitted: true, max_output_tokens: 94, max_cost_usd: "0.000500"
    });
    expect(await jobs.quoteResponse(JOB_ID, { ...INPUT, max_cost_usd: "0.000200" })).toMatchObject({
      admitted: false, reason: "REQUEST_COST_LIMIT", max_output_tokens: 27, max_cost_usd: null
    });
    expect(jobs.getJob(JOB_ID)).toEqual(before);
    expect(store.save).not.toHaveBeenCalled();
    expect(mock.createResponse).not.toHaveBeenCalled();
  });

  it("returns a denial without taking a response slot or reserving budget", async () => {
    const { jobs, store } = setup({ job: {
      budget_usd: "0.000200", final_reserve_usd: "0.000100", final_input_token_limit: 1, minimum_final_output_tokens: 1
    } });
    const before = jobs.getJob(JOB_ID);
    expect(await jobs.quoteResponse(JOB_ID, INPUT)).toMatchObject({
      admitted: false, reason: "OUTPUT_BELOW_MINIMUM", max_output_tokens: 5,
      max_cost_usd: null, max_cost_micro_usd: null, output_cost_usd: null, available_after_usd: null
    });
    expect(jobs.getJob(JOB_ID)).toEqual(before);
    expect(store.save).not.toHaveBeenCalled();
  });

  it("uses final phase policy limits and preserves the last response slot", async () => {
    const { jobs } = setup({ job: { budget_usd: "0.075", max_responses: 1 } });
    expect(await jobs.quoteResponse(JOB_ID, INPUT)).toMatchObject({ admitted: false, reason: "RESPONSE_LIMIT_REACHED" });
    expect(await jobs.quoteResponse(JOB_ID, { phase: "final", input: "Finish." })).toMatchObject({
      admitted: true, minimum_output_tokens: 256, max_output_tokens: 1200, protected_final_reserve_usd: "0.000000"
    });
    await jobs.createResponse(JOB_ID, { request_id: "final:1", phase: "final", input: "Finish." });
    expect(await jobs.quoteResponse(JOB_ID, INPUT)).toMatchObject({ admitted: false, reason: "UNRESOLVED_REQUEST" });
    jobs.finalizeJob(JOB_ID, { request_id: "final:1", accepted: true });
    expect(await jobs.quoteResponse(JOB_ID, INPUT)).toMatchObject({ admitted: false, reason: "JOB_CLOSED" });
  });

  it("denies an oversized final context and unresolved provider call", async () => {
    const mock = provider();
    const { jobs } = setup({ provider: mock, job: { budget_usd: "0.075", final_input_token_limit: 50 } });
    expect(await jobs.quoteResponse(JOB_ID, { phase: "final", input: "Finish." })).toMatchObject({ admitted: false, reason: "FINAL_INPUT_LIMIT_EXCEEDED" });
    mock.createResponse.mockRejectedValueOnce(new Error("Connection lost"));
    await jobs.createResponse(JOB_ID, { ...INPUT, request_id: "work:1" });
    expect(await jobs.quoteResponse(JOB_ID, INPUT)).toMatchObject({ admitted: false, reason: "UNRESOLVED_REQUEST" });
  });

  it("keeps counted input immutable if caller mutates its draft", async () => {
    const mock = provider();
    const { jobs } = setup({ provider: mock });
    const draft = { ...INPUT, input: [{ role: "user", content: "Original" }] };
    mock.countInput.mockImplementationOnce(async (context) => {
      draft.input[0]!.content = "Changed";
      expect(Object.isFrozen(context.input)).toBe(true);
      return 100;
    });
    const quote = await jobs.quoteResponse(JOB_ID, draft);
    const expected = prepareResponseContext({ model: "gpt-5.4-mini", service_tier: "default", input: [{ role: "user", content: "Original" }] });
    expect(quote.context_sha256).toBe(expected.sha256);
  });

  it.each(["before", "after"])("honors cancellation %s token counting without mutation", async (when) => {
    const mock = provider();
    const { jobs, store } = setup({ provider: mock });
    const cancellation = new AbortController();
    if (when === "before") cancellation.abort();
    else mock.countInput.mockImplementationOnce(async () => { cancellation.abort(); return 100; });
    const before = jobs.getJob(JOB_ID);
    await expect(jobs.quoteResponse(JOB_ID, INPUT, cancellation.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.countInput).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
    expect(mock.createResponse).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(jobs.getJob(JOB_ID)).toEqual(before);
  });

  it.each(["failure", "invalid count"])("does not reserve or persist after a preflight %s", async (kind) => {
    const mock = provider();
    if (kind === "failure") mock.countInput.mockRejectedValueOnce(new Error("private provider detail"));
    else mock.countInput.mockResolvedValueOnce(-1);
    const { jobs, store } = setup({ provider: mock });
    const before = jobs.getJob(JOB_ID);
    await expect(jobs.quoteResponse(JOB_ID, INPUT)).rejects.toMatchObject({ code: "PREFLIGHT_FAILED", status: 502 });
    expect(jobs.getJob(JOB_ID)).toEqual(before);
    expect(store.save).not.toHaveBeenCalled();
    expect(mock.createResponse).not.toHaveBeenCalled();
  });

  it("quotes the latest settled balance if spending changes during token counting", async () => {
    const counted = deferred<number>();
    const mock = provider();
    mock.countInput.mockImplementationOnce(() => counted.promise);
    const { jobs } = setup({ provider: mock });
    const pending = jobs.quoteResponse(JOB_ID, INPUT);
    await jobs.createResponse(JOB_ID, { ...INPUT, request_id: "concurrent" });
    counted.resolve(100);
    expect(await pending).toMatchObject({ admitted: true, available_after_usd: "0.058858" });
  });

  it("rejects a quote if another response becomes busy while counting", async () => {
    const counted = deferred<number>();
    const completing = deferred<TerminalResponse>();
    const started = deferred<void>();
    const mock = provider();
    mock.countInput.mockImplementationOnce(() => counted.promise);
    const terminal = await mock.createResponse({ model: "gpt-5.4-mini" } as GovernedResponseRequest);
    mock.createResponse.mockImplementationOnce(() => { started.resolve(); return completing.promise; });
    const { jobs } = setup({ provider: mock });
    const quote = jobs.quoteResponse(JOB_ID, INPUT);
    const response = jobs.createResponse(JOB_ID, { ...INPUT, request_id: "concurrent" });
    await started.promise;
    counted.resolve(100);
    await expect(quote).rejects.toMatchObject({ code: "JOB_BUSY", status: 409 });
    completing.resolve(terminal);
    await response;
  });

  it("rechecks storage availability after token counting", async () => {
    const mock = provider();
    const { jobs, store } = setup({ provider: mock });
    mock.countInput.mockImplementationOnce(async () => {
      store.assertAvailable.mockImplementation(() => { throw new Error("Writer ownership lost"); });
      return 100;
    });
    await expect(jobs.quoteResponse(JOB_ID, INPUT)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", status: 503 });
    expect(mock.createResponse).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it("rechecks the attempt limit after concurrent preflight failures", async () => {
    const counted = deferred<number>();
    const mock = provider();
    mock.countInput.mockRejectedValue(new Error("Preflight unavailable"));
    mock.countInput.mockImplementationOnce(() => counted.promise);
    const { jobs, store } = setup({ provider: mock });
    const quote = jobs.quoteResponse(JOB_ID, INPUT);
    for (let index = 0; index < 64; index++) {
      await expect(jobs.createResponse(JOB_ID, { ...INPUT, request_id: `failed:${index}` })).rejects.toMatchObject({ code: "PREFLIGHT_FAILED" });
    }
    const before = jobs.getJob(JOB_ID);
    store.save.mockClear();
    counted.resolve(100);
    await expect(quote).rejects.toMatchObject({ code: "ATTEMPT_LIMIT_REACHED", status: 429 });
    expect(jobs.getJob(JOB_ID)).toEqual(before);
    expect(store.save).not.toHaveBeenCalled();
    expect(mock.createResponse).not.toHaveBeenCalled();
  });

  it("requires a token-counting provider without creating an attempt", async () => {
    const jobs = new GovernedJobService({ idFactory: () => JOB_ID });
    jobs.createJob({ budget_usd: "0.075" });
    const before = jobs.getJob(JOB_ID);
    await expect(jobs.quoteResponse(JOB_ID, INPUT)).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED", status: 503 });
    expect(jobs.getJob(JOB_ID)).toEqual(before);
  });

  it.each([
    { request_id: "not-allowed" }, { max_cost_usd: "0" }, { max_cost_usd: "-1" },
    { max_cost_usd: 1 }, { max_cost_usd: "0.0000001" }, { max_output_tokens: 2 },
    { model: "unpriced-model" }, { phase: "final", tools: [{ type: "function", name: "read" }] },
    { previous_response_id: "resp_old" }
  ])("rejects invalid quote fields before provider access: %j", async (fields) => {
    const mock = provider();
    const { jobs } = setup({ provider: mock });
    await expect(jobs.quoteResponse(JOB_ID, { ...INPUT, ...fields })).rejects.toMatchObject({ status: 400 });
    expect(mock.countInput).not.toHaveBeenCalled();
  });

  it("binds idempotency to the approved numeric ceiling without changing unbounded fingerprints", async () => {
    const { jobs } = setup();
    const request = { ...INPUT, request_id: "bounded", max_cost_usd: "0.002" };
    const first = await jobs.createResponse(JOB_ID, request);
    await expect(jobs.createResponse(JOB_ID, { ...request, max_cost_usd: "0.002000" })).resolves.toEqual(first);
    await expect(jobs.createResponse(JOB_ID, { ...request, max_cost_usd: "0.003" })).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
    const unbounded = await jobs.createResponse(JOB_ID, { ...INPUT, request_id: "unbounded" });
    const prepared = prepareResponseContext({ model: "gpt-5.4-mini", input: INPUT.input, service_tier: "default" });
    const oldFingerprint = createHash("sha256").update(JSON.stringify({
      context_sha256: prepared.sha256, phase: INPUT.phase, requested_max_output_tokens: 200, minimum_useful_output_tokens: 32
    })).digest("hex");
    expect(unbounded.body.request_fingerprint).toBe(oldFingerprint);
  });

  it("enforces the quote ceiling again when input grows before paid dispatch", async () => {
    const mock = provider();
    const { jobs } = setup({ provider: mock });
    const quote = await jobs.quoteResponse(JOB_ID, INPUT);
    mock.countInput.mockResolvedValueOnce(10_000);
    await expect(jobs.createResponse(JOB_ID, { ...INPUT, request_id: "changed-count", max_cost_usd: quote.max_cost_usd })).rejects.toMatchObject({ code: "GOVERNOR_DENIED", status: 409 });
    expect(mock.createResponse).not.toHaveBeenCalled();
  });

  it("serves the quote route with no-store and no provider generation", async () => {
    const mock = provider();
    const app = createApp({ provider: mock, jobIdFactory: () => JOB_ID });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await post("/v1/jobs", { budget_usd: "0.075" });
    const result = await post(`/v1/jobs/${JOB_ID}/quote`, INPUT);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toMatchObject({ object: "token_governor.quote", admitted: true });
    expect(mock.createResponse).not.toHaveBeenCalled();
    const missing = await post("/v1/jobs/missing/quote", INPUT);
    expect(missing.status).toBe(404);
  });
});
