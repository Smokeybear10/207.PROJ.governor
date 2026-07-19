import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GovernedJobService } from "../server/jobs/index.js";
import { FileJobStore, type JobStore } from "../server/jobs/store.js";
import type { TerminalResponse } from "../server/openai/index.js";
import { ScriptedResponsesProvider } from "../server/openai/scripted-provider.js";
import type { ResponsesProvider } from "../server/runtime/index.js";

const directories: string[] = [];
const stores: FileJobStore[] = [];
const JOB_ID = "job_persistent";
const WORK_REQUEST = {
  request_id: "work:1",
  phase: "work",
  input: "Review this change.",
  max_output_tokens: 200,
  minimum_output_tokens: 32
};

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "governor-job-state-"));
  directories.push(directory);
  return directory;
}

async function openStore(directory: string): Promise<FileJobStore> {
  const store = await FileJobStore.open(directory, 0);
  stores.push(store);
  return store;
}

function service(store: JobStore, provider?: ResponsesProvider): GovernedJobService {
  return new GovernedJobService({
    store,
    provider,
    idFactory: () => JOB_ID,
    now: () => new Date("2026-11-06T12:00:00.000Z")
  });
}

function scriptedProvider(): ScriptedResponsesProvider {
  return new ScriptedResponsesProvider([{
    inputTokens: 100,
    outputTokens: 20,
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Saved response." }]
    }]
  }]);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((callback) => { resolve = callback; });
  return { promise, resolve };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.close()));
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("durable governed jobs", () => {
  it("lists retained jobs in creation order after restart without a provider", async () => {
    const directory = createDirectory();
    const store = await openStore(directory);
    const provider = scriptedProvider();
    const entries = [
      { id: "job_a", createdAt: "2026-11-06T12:00:00.000Z" },
      { id: "job_b", createdAt: "2026-11-06T13:00:00.000Z" },
      { id: "job_z", createdAt: "2026-11-06T11:00:00.000Z" }
    ];
    let next = 0;
    const jobs = new GovernedJobService({
      store,
      provider,
      idFactory: () => entries[next++].id,
      now: () => new Date(entries[next - 1].createdAt)
    });
    jobs.createJob({ budget_usd: "0.075" });
    await jobs.createResponse("job_a", WORK_REQUEST);
    jobs.createJob({ budget_usd: "0.100" });
    jobs.createJob({ budget_usd: "0.125" });
    const before = jobs.listJobs();
    expect(before.data.map((job) => job.id)).toEqual(["job_b", "job_a", "job_z"]);
    await store.close();

    const restored = new GovernedJobService({ store: await openStore(directory) });
    expect(restored.listJobs()).toEqual(before);
    expect(restored.listJobs({ limit: "1", after: "job_a" })).toMatchObject({
      data: [{ id: "job_z", budget_usd: "0.125000", settled_usd: "0.000000" }],
      has_more: false,
      next_after: null
    });
    expect(provider.contexts).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
  });

  it.each([true, false])(
    "retains accounting and replays receipts after restart (provider configured: %s)",
    async (providerConfigured) => {
      const directory = createDirectory();
      const store = await openStore(directory);
      const provider = scriptedProvider();
      const first = service(store, provider);
      first.createJob({ budget_usd: "0.075" });
      const receipt = await first.createResponse(JOB_ID, WORK_REQUEST);
      const job = first.getJob(JOB_ID);
      expect(job).toMatchObject({
        accounting: { settled_micro_usd: 165, reserved_micro_usd: 0, responses_started: 1 }
      });
      await store.close();

      const unusedProvider = new ScriptedResponsesProvider([]);
      const restored = service(await openStore(directory), providerConfigured ? unusedProvider : undefined);
      expect(restored.getJob(JOB_ID)).toEqual(job);
      await expect(restored.getResponse(JOB_ID, WORK_REQUEST.request_id)).resolves.toEqual(receipt);
      await expect(restored.createResponse(JOB_ID, WORK_REQUEST)).resolves.toEqual(receipt);
      await expect(restored.createResponse(JOB_ID, {
        ...WORK_REQUEST,
        input: "A different request with the same ID."
      })).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT", status: 409 });
      expect(unusedProvider.contexts).toHaveLength(0);
      expect(unusedProvider.requests).toHaveLength(0);
      expect(provider.requests).toHaveLength(1);
      expect(restored.getJob(JOB_ID)).toEqual(job);
    }
  );

  it.each([true, false])("preserves pending and recorded final validation (accepted: %s)", async (accepted) => {
    const directory = createDirectory();
    const store = await openStore(directory);
    const first = service(store, scriptedProvider());
    first.createJob({ budget_usd: "0.075" });
    const request = { request_id: "final:1", phase: "final", input: "Write the final answer." };
    const receipt = await first.createResponse(JOB_ID, request);
    const pending = first.getJob(JOB_ID);
    expect(pending).toMatchObject({
      status: "validation_required",
      pending_final_validation_request_id: request.request_id,
      accounting: { settled_micro_usd: 165, responses_started: 1 }
    });
    await store.close();

    const nextStore = await openStore(directory);
    const restored = service(nextStore);
    expect(restored.getJob(JOB_ID)).toEqual(pending);
    await expect(restored.createResponse(JOB_ID, request)).resolves.toEqual(receipt);
    const finalized = restored.finalizeJob(JOB_ID, { request_id: request.request_id, accepted });
    expect(finalized).toMatchObject({
      status: accepted ? "completed" : "rejected",
      completion_accepted: accepted,
      pending_final_validation_request_id: null
    });
    await nextStore.close();

    expect(service(await openStore(directory)).getJob(JOB_ID)).toEqual(finalized);
  });

  it("keeps the full dispatched reservation after interruption and never redispatches it", async () => {
    const directory = createDirectory();
    const store = await openStore(directory);
    const dispatched = deferred<void>();
    const provider: ResponsesProvider = {
      countInput: vi.fn(async () => 100),
      createResponse: vi.fn(() => {
        dispatched.resolve();
        return new Promise<TerminalResponse>(() => {});
      })
    };
    const first = service(store, provider);
    first.createJob({ budget_usd: "0.075" });
    void first.createResponse(JOB_ID, WORK_REQUEST);
    await dispatched.promise;
    const before = first.getJob(JOB_ID);
    expect(before).toMatchObject({
      status: "response_in_flight",
      accounting: { reserved_micro_usd: 977, settled_micro_usd: 0, responses_started: 1 }
    });
    await store.close();

    const unusedProvider = scriptedProvider();
    const restored = service(await openStore(directory), unusedProvider);
    expect(restored.getJob(JOB_ID)).toMatchObject({
      status: "reconciliation_required",
      accounting: before.accounting,
      active_request: { status: "ambiguous", max_output_tokens: 200, reserved_micro_usd: 977 }
    });
    await expect(restored.createResponse(JOB_ID, WORK_REQUEST)).resolves.toMatchObject({
      statusCode: 202,
      body: { execution: { status: "unresolved", reason: "service_restarted" } }
    });
    await expect(restored.getResponse(JOB_ID, WORK_REQUEST.request_id)).resolves.toMatchObject({
      body: { execution: { status: "unresolved", reservation: { reserved_micro_usd: 977 } } }
    });
    await expect(restored.createResponse(JOB_ID, {
      ...WORK_REQUEST,
      request_id: "work:2",
      input: "Try more work."
    })).rejects.toMatchObject({
      code: "GOVERNOR_DENIED",
      details: { execution: { reason: "UNRESOLVED_REQUEST" } }
    });
    expect(unusedProvider.requests).toHaveLength(0);
    expect(provider.createResponse).toHaveBeenCalledTimes(1);
    expect(restored.getJob(JOB_ID).accounting).toEqual(before.accounting);
  });

  it("allows a fresh request ID after interruption during preflight without charging the old attempt", async () => {
    const directory = createDirectory();
    const store = await openStore(directory);
    const counting = deferred<void>();
    const provider: ResponsesProvider = {
      countInput: vi.fn(() => {
        counting.resolve();
        return new Promise<number>(() => {});
      }),
      createResponse: vi.fn()
    };
    const first = service(store, provider);
    first.createJob({ budget_usd: "0.075" });
    void first.createResponse(JOB_ID, WORK_REQUEST);
    await counting.promise;
    expect(first.getJob(JOB_ID)).toMatchObject({
      status: "response_in_flight",
      requests: [{ status: "in_progress" }]
    });
    expect(first.listJobs().data).toMatchObject([{
      status: "response_in_flight",
      settled_usd: "0.000000",
      reserved_usd: "0.000000",
      responses_started: 0
    }]);
    await store.close();

    const nextProvider = scriptedProvider();
    const restored = service(await openStore(directory), nextProvider);
    expect(restored.getJob(JOB_ID)).toMatchObject({
      status: "open",
      accounting: { settled_micro_usd: 0, reserved_micro_usd: 0, responses_started: 0 }
    });
    expect(restored.listJobs().data[0].status).toBe("open");
    await expect(restored.createResponse(JOB_ID, WORK_REQUEST)).rejects.toMatchObject({
      code: "PREFLIGHT_FAILED",
      details: { execution: { reason: "service_restarted" } }
    });
    await expect(restored.createResponse(JOB_ID, {
      ...WORK_REQUEST,
      request_id: "work:2"
    })).resolves.toMatchObject({
      statusCode: 200,
      body: { job: { accounting: { settled_micro_usd: 165, responses_started: 1 } } }
    });
    expect(provider.createResponse).not.toHaveBeenCalled();
    expect(nextProvider.requests).toHaveLength(1);
  });

  it("blocks another request ID while a response is pending and coalesces a matching retry", async () => {
    const store = await openStore(createDirectory());
    const script = scriptedProvider();
    const dispatched = deferred<void>();
    const finish = deferred<void>();
    const provider: ResponsesProvider = {
      countInput: vi.fn(script.countInput.bind(script)),
      createResponse: vi.fn(async (request) => {
        dispatched.resolve();
        await finish.promise;
        return script.createResponse(request);
      })
    };
    const jobs = service(store, provider);
    jobs.createJob({ budget_usd: "0.075" });
    const pending = jobs.createResponse(JOB_ID, WORK_REQUEST);
    await dispatched.promise;
    const retry = jobs.createResponse(JOB_ID, WORK_REQUEST);
    await expect(jobs.createResponse(JOB_ID, {
      ...WORK_REQUEST,
      request_id: "work:2"
    })).rejects.toMatchObject({ code: "JOB_BUSY", status: 409 });
    expect(provider.countInput).toHaveBeenCalledTimes(1);
    expect(provider.createResponse).toHaveBeenCalledTimes(1);
    finish.resolve();
    const receipt = await pending;
    await expect(retry).resolves.toEqual(receipt);
  });

  it("does not persist a second attempt between settlement and saving the first receipt", async () => {
    const store = await openStore(createDirectory());
    const dispatched = deferred<void>();
    const response = deferred<TerminalResponse>();
    const provider: ResponsesProvider = {
      countInput: vi.fn(async () => 100),
      createResponse: vi.fn(() => {
        dispatched.resolve();
        return response.promise;
      })
    };
    const save = vi.spyOn(store, "save");
    const jobs = service(store, provider);
    jobs.createJob({ budget_usd: "0.075" });
    const pending = jobs.createResponse(JOB_ID, WORK_REQUEST);
    await dispatched.promise;
    response.resolve({
      id: "resp_race",
      model: "gpt-5.4-mini",
      serviceTier: "default",
      status: "completed",
      output: [],
      usage: {
        inputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 20,
        reasoningOutputTokens: 0,
        totalTokens: 120
      }
    });
    await Promise.resolve();
    expect(jobs.getJob(JOB_ID)).toMatchObject({
      status: "response_in_flight",
      accounting: { settled_micro_usd: 165 },
      requests: [{ status: "in_progress" }]
    });
    await expect(jobs.createResponse(JOB_ID, {
      ...WORK_REQUEST,
      request_id: "work:2"
    })).rejects.toMatchObject({ code: "JOB_BUSY", status: 409 });
    await pending;
    expect(provider.countInput).toHaveBeenCalledTimes(1);
    expect(provider.createResponse).toHaveBeenCalledTimes(1);
    for (const [, value] of save.mock.calls) {
      const saved = value as {
        ledger: { reservations: Array<{ requestId: string; status: string }> };
        attempts: Array<{ requestId: string; outcome?: unknown }>;
      };
      for (const reservation of saved.ledger.reservations) {
        if (reservation.status === "settled") {
          expect(saved.attempts.find((attempt) => attempt.requestId === reservation.requestId)?.outcome)
            .toBeDefined();
        }
      }
    }
  });

  it.each([true, false])("waits for the final receipt before saving validation (accepted: %s)", async (accepted) => {
    const directory = createDirectory();
    const store = await openStore(directory);
    const dispatched = deferred<void>();
    const response = deferred<TerminalResponse>();
    const jobs = service(store, {
      countInput: async () => 100,
      createResponse: () => {
        dispatched.resolve();
        return response.promise;
      }
    });
    jobs.createJob({ budget_usd: "0.075" });
    const request = { request_id: "final:1", phase: "final", input: "Write the final answer." };
    const pending = jobs.createResponse(JOB_ID, request);
    await dispatched.promise;
    response.resolve({
      id: "resp_final_race",
      model: "gpt-5.4-mini",
      serviceTier: "default",
      status: "completed",
      output: [],
      usage: {
        inputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 20,
        reasoningOutputTokens: 0,
        totalTokens: 120
      }
    });
    await Promise.resolve();
    expect(jobs.getJob(JOB_ID)).toMatchObject({
      status: "validation_required",
      requests: [{ status: "in_progress" }]
    });
    expect(jobs.listJobs().data[0].status).toBe("validation_required");
    const filename = join(directory, `${JOB_ID}.json`);
    const before = readFileSync(filename, "utf8");
    expect(() => jobs.finalizeJob(JOB_ID, { request_id: request.request_id, accepted }))
      .toThrowError(expect.objectContaining({ code: "JOB_BUSY", status: 409 }));
    expect(readFileSync(filename, "utf8")).toBe(before);
    await pending;

    const finalized = jobs.finalizeJob(JOB_ID, { request_id: request.request_id, accepted });
    expect(finalized).toMatchObject({ status: accepted ? "completed" : "rejected" });
    await store.close();
    expect(service(await openStore(directory)).getJob(JOB_ID)).toEqual(finalized);
  });

  it.each([
    "invalid JSON",
    "unsupported version",
    "accounting mismatch",
    "missing receipt",
    "wrong job ID",
    "receipt accounting mismatch",
    "receipt response mismatch"
  ])(
    "refuses to load corrupt state: %s",
    async (corruption) => {
      const directory = createDirectory();
      const store = await openStore(directory);
      const jobs = service(store, scriptedProvider());
      jobs.createJob({ budget_usd: "0.075" });
      await jobs.createResponse(JOB_ID, WORK_REQUEST);
      await store.close();

      const filename = join(directory, `${JOB_ID}.json`);
      const saved = JSON.parse(readFileSync(filename, "utf8")) as {
        version: number;
        id: string;
        ledger: { settledMicroUsd: number };
        attempts: Array<{
          outcome: {
            execution: {
              response: { id: string };
              reservation: { settled_micro_usd: number };
            };
          };
        }>;
        nextAttemptSequence: number;
      };
      if (corruption === "unsupported version") saved.version = 2;
      if (corruption === "accounting mismatch") saved.ledger.settledMicroUsd = 0;
      if (corruption === "missing receipt") {
        saved.attempts = [];
        saved.nextAttemptSequence = 1;
      }
      if (corruption === "wrong job ID") saved.id = "job_wrong";
      if (corruption === "receipt accounting mismatch") {
        saved.attempts[0].outcome.execution.reservation.settled_micro_usd = 0;
      }
      if (corruption === "receipt response mismatch") {
        saved.attempts[0].outcome.execution.response.id = "resp_wrong";
      }
      writeFileSync(filename, corruption === "invalid JSON" ? "{" : JSON.stringify(saved));

      const nextStore = await openStore(directory);
      const provider = scriptedProvider();
      expect(() => service(nextStore, provider)).toThrow();
      expect(provider.contexts).toHaveLength(0);
      expect(provider.requests).toHaveLength(0);
    }
  );

  it("rejects a second writer and releases the directory on close", async () => {
    const directory = createDirectory();
    const store = await openStore(directory);
    const jobs = service(store);
    const created = jobs.createJob({ budget_usd: "0.075" });
    await expect(FileJobStore.open(directory, 0)).rejects.toMatchObject({ code: "ELOCKED" });
    await store.close();
    expect(() => store.save(JOB_ID, {})).toThrow("storage is unavailable");
    expect(service(await openStore(directory)).getJob(JOB_ID)).toEqual(created);
  });

  it("rejects a completed receipt paired with a fresh empty ledger", async () => {
    const directory = createDirectory();
    const store = await openStore(directory);
    const jobs = service(store, scriptedProvider());
    jobs.createJob({ budget_usd: "0.075" });
    const fresh = store.load()[0] as { ledger: unknown };
    await jobs.createResponse(JOB_ID, WORK_REQUEST);
    await store.close();

    const filename = join(directory, `${JOB_ID}.json`);
    const saved = JSON.parse(readFileSync(filename, "utf8")) as { ledger: unknown };
    saved.ledger = fresh.ledger;
    writeFileSync(filename, JSON.stringify(saved));

    const reopened = await openStore(directory);
    expect(() => service(reopened)).toThrow("does not match its ledger");
  });

  it("rejects a forged completed outcome for a dispatched request instead of skipping recovery", async () => {
    const completed = new GovernedJobService({ provider: scriptedProvider(), idFactory: () => JOB_ID });
    completed.createJob({ budget_usd: "0.075" });
    const receipt = await completed.createResponse(JOB_ID, WORK_REQUEST);
    const execution = receipt.body.execution as Record<string, unknown>;

    const directory = createDirectory();
    const store = await openStore(directory);
    const dispatched = deferred<void>();
    const jobs = service(store, {
      countInput: async () => 100,
      createResponse: () => {
        dispatched.resolve();
        return new Promise<TerminalResponse>(() => {});
      }
    });
    jobs.createJob({ budget_usd: "0.075" });
    void jobs.createResponse(JOB_ID, WORK_REQUEST);
    await dispatched.promise;
    const activeReservation = jobs.getJob(JOB_ID).active_request;
    await store.close();

    const filename = join(directory, `${JOB_ID}.json`);
    const saved = JSON.parse(readFileSync(filename, "utf8")) as { attempts: Array<{ outcome?: unknown }> };
    saved.attempts[0].outcome = {
      kind: "response",
      statusCode: 200,
      execution: { ...execution, reservation: activeReservation }
    };
    writeFileSync(filename, JSON.stringify(saved));

    const reopened = await openStore(directory);
    expect(() => service(reopened)).toThrow("does not match its ledger");
  });

  it("blocks all further spending when saving the dispatched reservation fails", async () => {
    const directory = createDirectory();
    const store = await openStore(directory);
    const provider = scriptedProvider();
    const jobs = service(store, provider);
    jobs.createJob({ budget_usd: "0.075" });
    const save = store.save.bind(store);
    vi.spyOn(store, "save")
      .mockImplementationOnce(save)
      .mockImplementationOnce(() => { throw new Error("disk full"); });

    await expect(jobs.createResponse(JOB_ID, WORK_REQUEST)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE", status: 503
    });
    expect(provider.requests).toHaveLength(0);
    await expect(jobs.createResponse(JOB_ID, { ...WORK_REQUEST, request_id: "work:2" }))
      .rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", status: 503 });
    expect(() => jobs.createJob({ budget_usd: "0.075" })).toThrowError(
      expect.objectContaining({ code: "STORAGE_UNAVAILABLE" })
    );
    expect(() => jobs.listJobs()).toThrowError(
      expect.objectContaining({ code: "STORAGE_UNAVAILABLE", status: 503 })
    );
    expect(provider.contexts).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    await store.close();

    const recovered = service(await openStore(directory));
    expect(recovered.getJob(JOB_ID)).toMatchObject({
      status: "open",
      accounting: { settled_micro_usd: 0, reserved_micro_usd: 0, responses_started: 0 }
    });
  });
});
