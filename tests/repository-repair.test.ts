import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { GovernedJobService } from "../server/jobs/index.js";
import type { JobStore } from "../server/jobs/store.js";
import { ScriptedResponsesProvider } from "../server/openai/scripted-provider.js";
import { brokenSumRepairScripts } from "../server/repair/demo-script.js";
import { getRepairFixture } from "../server/repair/fixtures.js";
import { parseRepositoryRequest, repositoryFingerprint, runRepositoryRepair } from "../server/repair/repository.js";
import { RepositoryRepairRuns } from "../server/repair/repository-runs.js";

async function request() {
  const fixture = getRepairFixture("broken-sum");
  return {
    requestId: randomUUID(),
    budgetUsd: "0.20",
    maxResponses: 8,
    editablePaths: [...fixture.allowlistedPaths],
    testPaths: [...fixture.protectedPaths],
    files: await Promise.all([...fixture.allowlistedPaths, ...fixture.protectedPaths].map(async (path) => ({
      path, content: await readFile(join(fixture.rootDir, path), "utf8")
    })))
  };
}

function memoryStore(): JobStore & { records: Map<string, unknown> } {
  const records = new Map<string, unknown>();
  return {
    records,
    assertAvailable() {},
    load: () => [...records.values()].map((value) => structuredClone(value)),
    save: (id, value) => { records.set(id, structuredClone(value)); }
  };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("repository repair input", () => {
  it("binds the budget and file contents to the request identity", async () => {
    const input = parseRepositoryRequest(await request());
    expect(repositoryFingerprint(input)).toBe(repositoryFingerprint({ ...input, files: [...input.files].reverse() }));
    expect(repositoryFingerprint(input)).not.toBe(repositoryFingerprint({ ...input, budgetUsd: "0.30" }));
    expect(repositoryFingerprint(input)).not.toBe(repositoryFingerprint({ ...input, files: input.files.map((file) => ({ ...file, content: `${file.content}\n` })) }));
  });

  it("rejects traversal, ambiguous filenames, private files, unbounded input and mutable tests", async () => {
    const input = await request();
    for (const path of ["../escape.js", "/tmp/out.js", "src\\out.js", ".env", ".git/config.json", "node_modules/pkg/x.js", "src/a.js/child.js", "src/--import.js", "src/a.js."]) {
      const files = [...input.files, { path, content: "x" }];
      if (path === "src/a.js/child.js") files.push({ path: "src/a.js", content: "x" });
      expect(() => parseRepositoryRequest({ ...input, files })).toThrow();
    }
    expect(() => parseRepositoryRequest({ ...input, files: [...input.files, { ...input.files[0]!, path: input.files[0]!.path.toUpperCase() }] })).toThrow();
    expect(() => parseRepositoryRequest({ ...input, files: input.files.map((file) => ({ ...file, content: "x".repeat(65_537) })) })).toThrow();
    expect(() => parseRepositoryRequest({ ...input, editablePaths: input.testPaths })).toThrow();
    expect(() => parseRepositoryRequest({ ...input, testPaths: ["missing.test.js"] })).toThrow();
    expect(() => parseRepositoryRequest({ ...input, budgetUsd: "1000" })).toThrow();
    expect(() => parseRepositoryRequest({ ...input, rootDir: "/tmp" })).toThrow();
    expect(() => parseRepositoryRequest({ ...input, requestId: input.requestId.toUpperCase() })).toThrow();
    expect(() => parseRepositoryRequest({ ...input, files: [...input.files, { path: "SRC/helper.mjs", content: "" }] })).toThrow();
    expect(() => parseRepositoryRequest({ ...input, files: [...input.files, { path: "credentials.json", content: "{}" }] })).toThrow();
    expect(() => parseRepositoryRequest({ ...input, files: input.files.map((file) => ({ ...file, content: "\ud800" })) })).toThrow();
  });
});

describe.runIf(process.platform === "darwin")("repository repairs", () => {
  it("repairs an uploaded snapshot and returns a verified reviewable patch without editing the source", async () => {
    const input = await request();
    const original = structuredClone(input);
    const provider = new ScriptedResponsesProvider(brokenSumRepairScripts());
    const checkpoints: unknown[] = [];
    const output = await runRepositoryRepair(input, {
      service: new GovernedJobService({ provider }),
      onCheckpoint: (checkpoint) => checkpoints.push(structuredClone(checkpoint))
    });
    expect(output.status).toBe("completed");
    expect(output.baseline.exitCode).toBe(1);
    expect(output.result?.status).toBe("repaired");
    expect(output.result?.evaluation?.passed, JSON.stringify(output)).toBe(true);
    expect(output.changes).toHaveLength(1);
    expect(output.changes[0]?.after).toContain("return a + b");
    expect(output.changes[0]?.before).toContain("return a - b");
    expect(input).toEqual(original);
    expect(output.jobId).toBeTruthy();
    expect(checkpoints.length).toBeGreaterThan(3);
    provider.assertComplete();
    expect((await request()).files).toEqual(input.files);
  });

  it("does not spend when the selected tests already pass or cannot load", async () => {
    for (const state of ["passing", "missing_dependency"]) {
      const input = await request();
      const provider = new ScriptedResponsesProvider([]);
      input.files[0]!.content = state === "passing"
        ? input.files[0]!.content.replace("return a - b", "return a + b")
        : "import 'missing-dependency';\nexport function add() {}";
      const output = await runRepositoryRepair(input, { service: new GovernedJobService({ provider }) });
      expect(output.status).toBe(state === "passing" ? "already_passing" : "baseline_failed");
      expect(output.result).toBeNull();
      expect(output.changes).toEqual([]);
      expect(provider.requests).toEqual([]);
      provider.assertComplete();
    }
  });

  it("retains partial changes and accounting when a later preflight fails", async () => {
    const input = await request();
    const provider = new ScriptedResponsesProvider([brokenSumRepairScripts()[1]!]);
    const output = await runRepositoryRepair(input, { service: new GovernedJobService({ provider }) });
    expect(output.result).toMatchObject({ status: "not_repaired", reason: "WORK_PREFLIGHT_FAILED" });
    expect(output.changes).toHaveLength(1);
    expect(output.result!.settledMicroUsd).toBeGreaterThan(0);
    expect(output.result!.accounting.committedMicroUsd).toBeLessThanOrEqual(200_000);
  });

  it("repairs a TypeScript snapshot from this repository without changing its working file", async () => {
    const original = await readFile(new URL("../server/startup.ts", import.meta.url), "utf8");
    const input = {
      requestId: randomUUID(), budgetUsd: "0.20", maxResponses: 8,
      editablePaths: ["server/startup.ts"], testPaths: ["test/startup.test.ts"],
      files: [
        { path: "server/startup.ts", content: original.replace("port > 65_535", "port >= 65_535") },
        { path: "test/startup.test.ts", content: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { parseStartupPort } from '../server/startup.ts';\ntest('accepts last valid port', () => assert.equal(parseStartupPort('65535'), 65535));\ntest('rejects outside range', () => assert.throws(() => parseStartupPort('65536')));\n" }
      ]
    };
    const scripts = brokenSumRepairScripts();
    scripts[1] = {
      inputTokens: 1_100, outputTokens: 64,
      output: [{ type: "function_call", id: "fc_patch", call_id: "patch", name: "apply_patch", status: "completed",
        arguments: JSON.stringify({ edits: [{ path: "server/startup.ts", old_text: "port >= 65_535", new_text: "port > 65_535" }] }) }]
    };
    const provider = new ScriptedResponsesProvider(scripts);
    const output = await runRepositoryRepair(input, { service: new GovernedJobService({ provider }) });
    expect(output.result?.evaluation?.passed, JSON.stringify(output)).toBe(true);
    expect(output.changes[0]?.after).toBe(original);
    expect(await readFile(new URL("../server/startup.ts", import.meta.url), "utf8")).toBe(original);
    provider.assertComplete();
  });

  it("stops polling as failed if checkpoint storage fails, and blocks further spending", async () => {
    const input = await request();
    const provider = new ScriptedResponsesProvider(brokenSumRepairScripts());
    const store = memoryStore();
    const save = store.save;
    let writes = 0;
    store.save = (id, value) => {
      if (++writes >= 4) throw new Error("disk full");
      save(id, value);
    };
    const manager = new RepositoryRepairRuns(new GovernedJobService({ provider }), store);
    manager.start(input);
    await manager.waitForIdle();
    expect(manager.get(input.requestId)).toMatchObject({ status: "failed" });
    expect(String(manager.get(input.requestId).error)).toContain("storage failed");
    expect(provider.requests).toHaveLength(1);
    expect(() => manager.start({ ...input, requestId: randomUUID() })).toThrow(/storage is unavailable/);
  });

  it("deduplicates submissions across reconnect and restart while rejecting changed snapshots", async () => {
    const input = await request();
    const provider = new ScriptedResponsesProvider(brokenSumRepairScripts());
    const service = new GovernedJobService({ provider });
    const store = memoryStore();
    const manager = new RepositoryRepairRuns(service, store);
    expect(manager.start(input)).toMatchObject({ status: "running", requestId: input.requestId });
    expect(manager.start(input)).toMatchObject({ status: "running" });
    expect(() => manager.start({ ...input, budgetUsd: "0.30" })).toThrow(/different repair/);
    expect(() => manager.start({ ...input, requestId: randomUUID() })).toThrow(/Another repository repair/);
    await manager.waitForIdle();
    expect(manager.get(input.requestId)).toMatchObject({ status: "completed", result: { result: { status: "repaired" } } });
    const restored = new RepositoryRepairRuns(service, store);
    expect(restored.start(input)).toEqual(manager.get(input.requestId));
    expect(provider.requests).toHaveLength(4);
    provider.assertComplete();
  });

  it("marks interrupted runs failed and keeps their last patch instead of spending again", async () => {
    const input = parseRepositoryRequest(await request());
    const store = memoryStore();
    const provider = new ScriptedResponsesProvider([]);
    const partial = { changes: [{ path: input.editablePaths[0], before: "broken", after: "candidate" }] };
    store.save(input.requestId, { id: input.requestId, fingerprint: repositoryFingerprint(input), status: "running", output: partial, jobId: "saved-job" });
    const manager = new RepositoryRepairRuns(new GovernedJobService({ provider }), store);
    expect(manager.start(input)).toMatchObject({ status: "failed", result: partial, jobId: "saved-job" });
    expect(String(manager.get(input.requestId).error)).toContain("No model requests were retried");
    provider.assertComplete();
  });

  it("exposes asynchronous local API runs and blocks demo-only deployments", async () => {
    const provider = new ScriptedResponsesProvider(brokenSumRepairScripts());
    const server = createApp({ provider }).listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const input = await request();
    const started = await fetch(`${base}/api/repair/repository/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    expect(started.status).toBe(202);
    let view = await started.json() as { status: string; result?: unknown };
    for (let attempt = 0; view.status === "running" && attempt < 300; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const response = await fetch(`${base}/api/repair/repository/runs/${input.requestId}`);
      expect(response.status).toBe(200);
      view = await response.json() as typeof view;
    }
    expect(view).toMatchObject({ status: "completed", result: { result: { status: "repaired" } } });
    provider.assertComplete();
    const demo = createApp({ provider, exposeGovernedApi: false, forcedRepairMode: "fake" }).listen(0, "127.0.0.1");
    servers.push(demo);
    await once(demo, "listening");
    const response = await fetch(`http://127.0.0.1:${(demo.address() as AddressInfo).port}/api/repair/repository/runs/${input.requestId}`);
    expect(response.status).toBe(404);
  });
});
