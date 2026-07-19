import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.js";
import { GovernedJobService } from "../server/jobs/index.js";
import type { JobStore } from "../server/jobs/store.js";
import type { GovernedResponseRequest, TerminalResponse } from "../server/openai/index.js";
import type { ResponsesProvider } from "../server/runtime/index.js";

const JOB = "job_recovery";
const REQUEST = {
  request_id: "work:recover", phase: "work", input: "Keep this response.",
  max_output_tokens: 200, minimum_output_tokens: 32
};
const servers: Server[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function response(): TerminalResponse {
  return {
    id: "resp_recovered", model: "gpt-5.4-mini", serviceTier: "default", status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Recovered answer." }] }],
    usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 120 }
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

describe("disconnected response recovery", () => {
  it("finishes and saves one dispatched response after an HTTP disconnect, including duplicate retries", async () => {
    const started = deferred<void>();
    const disconnected = deferred<void>();
    const completion = deferred<TerminalResponse>();
    const store = memoryStore();
    const provider: ResponsesProvider = {
      countInput: vi.fn(async (_context, signal) => {
        signal?.addEventListener("abort", () => disconnected.resolve(), { once: true });
        return 100;
      }),
      createResponse: vi.fn(async (_request: GovernedResponseRequest, signal?: AbortSignal) => {
        signal?.addEventListener("abort", () => completion.reject(signal.reason), { once: true });
        started.resolve();
        return completion.promise;
      })
    };
    const server = createApp({ provider, jobStore: store, jobIdFactory: () => JOB }).listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/jobs`;
    await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ budget_usd: "0.075" }) });
    const send = (body = REQUEST, signal?: AbortSignal) => fetch(`${base}/${JOB}/responses`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal
    });
    const controller = new AbortController();
    const original = send(REQUEST, controller.signal).catch((error: unknown) => error);
    await started.promise;
    controller.abort();
    expect(await original).toBeInstanceOf(Error);
    await disconnected.promise;

    expect(vi.mocked(provider.createResponse).mock.calls[0][1]).toBeUndefined();
    expect(await (await fetch(`${base}/${JOB}`)).json()).toMatchObject({
      status: "response_in_flight", accounting: { responses_started: 1, settled_micro_usd: 0 }
    });
    const competing = await send({ ...REQUEST, request_id: "work:other" });
    expect(competing.status).toBe(409);
    expect(await competing.json()).toMatchObject({ error: { code: "JOB_BUSY" } });
    const retried = send();
    const reopened = fetch(`${base}/${JOB}/responses/${encodeURIComponent(REQUEST.request_id)}`);
    completion.resolve(response());
    const [retryReceipt, savedReceipt] = await Promise.all([retried, reopened]);
    expect(retryReceipt.status).toBe(200);
    const receipt: unknown = await retryReceipt.json();
    expect(await savedReceipt.json()).toEqual(receipt);
    expect(receipt).toMatchObject({
      execution: { status: "settled", response: { id: "resp_recovered" } },
      job: { accounting: { settled_micro_usd: 165, reserved_micro_usd: 0, responses_started: 1 } }
    });
    expect(provider.countInput).toHaveBeenCalledTimes(1);
    expect(provider.createResponse).toHaveBeenCalledTimes(1);
    const restarted = new GovernedJobService({ store });
    expect((await restarted.getResponse(JOB, REQUEST.request_id)).body).toEqual(receipt);
  });

  it("still cancels before generation while preflight is pending", async () => {
    const counting = deferred<void>();
    const count = deferred<number>();
    const provider: ResponsesProvider = {
      countInput: vi.fn(async () => { counting.resolve(); return count.promise; }),
      createResponse: vi.fn(async () => response())
    };
    const jobs = new GovernedJobService({ provider, idFactory: () => JOB });
    jobs.createJob({ budget_usd: "0.075" });
    const controller = new AbortController();
    const attempt = jobs.createResponse(JOB, REQUEST, controller.signal, { continueAfterDispatch: true });
    await counting.promise;
    controller.abort();
    count.resolve(100);
    await expect(attempt).rejects.toMatchObject({ code: "PREFLIGHT_FAILED" });
    expect(provider.createResponse).not.toHaveBeenCalled();
    expect(jobs.getJob(JOB)).toMatchObject({
      accounting: { settled_micro_usd: 0, reserved_micro_usd: 0, responses_started: 0 }
    });
  });

  it("preserves explicit cancellation for direct and repair callers by default", async () => {
    const started = deferred<void>();
    const completion = deferred<TerminalResponse>();
    const provider: ResponsesProvider = {
      countInput: vi.fn(async () => 100),
      createResponse: vi.fn(async (_request: GovernedResponseRequest, signal?: AbortSignal) => {
        signal?.addEventListener("abort", () => completion.reject(signal.reason), { once: true });
        started.resolve();
        return completion.promise;
      })
    };
    const jobs = new GovernedJobService({ provider, idFactory: () => JOB });
    jobs.createJob({ budget_usd: "0.075" });
    const controller = new AbortController();
    const attempt = jobs.createResponse(JOB, REQUEST, controller.signal);
    await started.promise;
    controller.abort();
    expect(await attempt).toMatchObject({ statusCode: 202, body: { execution: { status: "unresolved" },
      job: { status: "reconciliation_required", accounting: { reserved_micro_usd: 977, settled_micro_usd: 0 } } } });
    expect(vi.mocked(provider.createResponse).mock.calls[0][1]).toBe(controller.signal);
  });

  it("retains the full reservation when the provider fails after the client leaves", async () => {
    const started = deferred<void>();
    const completion = deferred<TerminalResponse>();
    const store = memoryStore();
    const provider: ResponsesProvider = {
      countInput: vi.fn(async () => 100),
      createResponse: vi.fn(async () => { started.resolve(); return completion.promise; })
    };
    const jobs = new GovernedJobService({ store, provider, idFactory: () => JOB });
    jobs.createJob({ budget_usd: "0.075" });
    const controller = new AbortController();
    const attempt = jobs.createResponse(JOB, REQUEST, controller.signal, { continueAfterDispatch: true });
    await started.promise;
    controller.abort();
    completion.reject(new Error("provider transport timeout"));
    const receipt = await attempt;
    expect(receipt).toMatchObject({ statusCode: 202, body: { execution: { status: "unresolved" },
      job: { status: "reconciliation_required", accounting: { reserved_micro_usd: 977, settled_micro_usd: 0 } } } });
    const restarted = new GovernedJobService({ store, provider });
    await expect(restarted.createResponse(JOB, REQUEST)).resolves.toEqual(receipt);
    expect(provider.countInput).toHaveBeenCalledTimes(1);
    expect(provider.createResponse).toHaveBeenCalledTimes(1);
  });
});
