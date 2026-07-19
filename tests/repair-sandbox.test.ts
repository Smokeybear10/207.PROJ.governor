import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import { getRepairFixture } from "../server/repair/fixtures.js";
import type { RepairFixture } from "../server/repair/types.js";
import { createRepairSandbox, verifyFinalState } from "../server/repair/sandbox.js";

const BUGGY_ADD = "export function add(a, b) {\n  return a - b;\n}";
const FIXED_ADD = "export function add(a, b) {\n  return a + b;\n}";

describe("repair sandbox (broken-sum)", () => {
  it.each(["cancel", "timeout"] as const)("stops isolated tests on %s", async (stop) => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "governor-stop-test-"));
    await writeFile(join(fixtureDir, "loop.test.mjs"), "setInterval(() => {}, 1000);");
    const sandbox = await createRepairSandbox({
      id: "bounded-test", rootDir: fixtureDir, allowlistedPaths: [],
      protectedPaths: ["loop.test.mjs"], testCommand: ["node", "--test"], maxEditFiles: 0
    });
    const controller = new AbortController();
    if (stop === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = sandbox.runTests(controller.signal).then(
      (result) => `exit ${result.exitCode}`,
      (error: unknown) => error instanceof Error ? error.message : String(error)
    );
    try {
      await delay(100);
      if (stop === "cancel") controller.abort(new Error("cancel isolated test"));
      else await vi.advanceTimersByTimeAsync(30_000);
      expect(await Promise.race([run, delay(1_000, "still running")])).toBe(
        stop === "cancel" ? "cancel isolated test" : "exit 124"
      );
    } finally {
      controller.abort();
      await run;
      vi.useRealTimers();
      await sandbox.dispose();
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("denies host reads, writes, networking, and subprocesses during tests and final verification", async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "governor-canary-fixture-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "governor-canary-outside-"));
    const outsideFile = join(outsideDir, "private-canary.txt");
    const secretName = "GOVERNOR_TEST_CANARY_SECRET";
    await writeFile(outsideFile, "harmless-canary");
    vi.stubEnv(secretName, "must-not-reach-tests");
    let connections = 0;
    const server = createServer((_request, response) => {
      connections += 1;
      response.end("should not connect");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("Missing canary port.");
    const fixture: RepairFixture = {
      id: "host-canary", rootDir: fixtureDir, allowlistedPaths: ["candidate.mjs"],
      protectedPaths: ["canary.test.mjs"], testCommand: ["node", "--test"], maxEditFiles: 1
    };
    const source = `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync, symlinkSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      import { request } from 'node:http';
      export async function check() {
        assert.throws(() => readFileSync(${JSON.stringify(outsideFile)}, 'utf8'), {code: 'EPERM'});
        assert.throws(() => writeFileSync(${JSON.stringify(outsideFile)}, 'changed'), {code: 'EPERM'});
        assert.throws(() => writeFileSync('./canary.test.mjs', 'changed'), {code: 'EPERM'});
        assert.throws(() => symlinkSync(${JSON.stringify(outsideFile)}, './escape-link'), {code: 'EPERM'});
        assert.equal(spawnSync(process.execPath, ['-e', 'console.log("escaped")']).error.code, 'EPERM');
        assert.equal(spawnSync('/bin/sh', ['-c', 'true']).error.code, 'EPERM');
        assert.equal(process.env.${secretName}, undefined);
        await new Promise((resolve, reject) => {
          const req = request('http://127.0.0.1:${address.port}/', () => reject(new Error('network escaped')));
          req.on('error', (error) => { try { assert.equal(error.code, 'EPERM'); resolve(); } catch (failure) { reject(failure); } });
          req.end();
        });
      }
    `;
    await writeFile(join(fixtureDir, "candidate.mjs"), source);
    await writeFile(join(fixtureDir, "canary.test.mjs"), "import {test} from 'node:test'; import {check} from './candidate.mjs'; test('host restrictions hold', check);");
    let sandbox: Awaited<ReturnType<typeof createRepairSandbox>> | undefined;
    try {
      sandbox = await createRepairSandbox(fixture);
      const live = await sandbox.runTests();
      expect(live.exitCode, live.stdout).toBe(0);
      expect(live.stdout).toContain("host restrictions hold");
      const sealed = await verifyFinalState(fixture, new Map([["candidate.mjs", source]]));
      expect(sealed.exitCode, sealed.stdout).toBe(0);
      expect(sealed.stdout).toContain("host restrictions hold");
      expect(await readFile(outsideFile, "utf8")).toBe("harmless-canary");
      expect(connections).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      server.close();
      await sandbox?.dispose();
      await rm(fixtureDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects symlink fixtures and unsafe paths before applying host edits", async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "governor-symlink-fixture-"));
    const targetDir = await mkdtemp(join(tmpdir(), "governor-symlink-outside-"));
    await writeFile(join(targetDir, "target.mjs"), "harmless-canary");
    await symlink(join(targetDir, "target.mjs"), join(fixtureDir, "source.mjs"));
    const fixture: RepairFixture = {
      id: "symlink-test", rootDir: fixtureDir, allowlistedPaths: ["source.mjs"],
      protectedPaths: [], testCommand: ["node", "--test"], maxEditFiles: 1
    };
    try {
      await expect(createRepairSandbox(fixture)).rejects.toThrow("symbolic links");
      await expect(verifyFinalState(fixture, new Map([["source.mjs", "changed"]]))).rejects.toThrow("symbolic links");
      await expect(createRepairSandbox({...fixture, allowlistedPaths: ["../target.mjs"]})).rejects.toThrow("inside the working copy");
      expect(await readFile(join(targetDir, "target.mjs"), "utf8")).toBe("harmless-canary");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("fails, accepts a valid fix, and rejects illegal edits", async () => {
    const fixture = getRepairFixture("broken-sum");
    const sandbox = await createRepairSandbox(fixture);

    try {
      expect(sandbox.allowlistedPaths).toContain("src/calculator.mjs");

      const listed = sandbox.listFiles();
      expect(listed.map((info) => info.path)).toEqual(["src/calculator.mjs"]);
      expect(listed[0].bytes).toBeGreaterThan(0);
      expect(listed[0].lines).toBeGreaterThan(0);

      const revisionBefore = sandbox.revision();
      const source = sandbox.readFile("src/calculator.mjs");
      expect(source).toContain(BUGGY_ADD);

      const failing = await sandbox.runTests();
      expect(failing.exitCode).not.toBe(0);
      expect(failing.durationMs).toBeGreaterThanOrEqual(0);
      expect(sandbox.editedPaths()).toEqual([]);

      const cancelled = new AbortController();
      cancelled.abort(new Error("test cancellation"));
      await expect(sandbox.runTests(cancelled.signal)).rejects.toThrow(
        "test cancellation"
      );

      // Reading a non-allowlisted path throws.
      expect(() => sandbox.readFile("test/calculator.test.mjs")).toThrow();

      // Edit to a non-allowlisted (protected) path is rejected all-or-nothing.
      const badPath = sandbox.applyEdits([
        {
          path: "test/calculator.test.mjs",
          oldText: "add",
          newText: "sub"
        }
      ]);
      expect(badPath.applied).toBe(false);
      expect(badPath.changedPaths).toEqual([]);
      expect(badPath.rejected).toHaveLength(1);
      expect(badPath.rejected[0].path).toBe("test/calculator.test.mjs");

      // Edit whose oldText does not exist is rejected.
      const missing = sandbox.applyEdits([
        {
          path: "src/calculator.mjs",
          oldText: "this text is not present anywhere",
          newText: "noop"
        }
      ]);
      expect(missing.applied).toBe(false);
      expect(missing.rejected[0].reason).toMatch(/not found/i);

      // Ambiguous oldText (occurs multiple times) is rejected.
      const ambiguous = sandbox.applyEdits([
        {
          path: "src/calculator.mjs",
          oldText: "a, b",
          newText: "a, b /* x */"
        }
      ]);
      expect(ambiguous.applied).toBe(false);
      expect(ambiguous.rejected[0].reason).toMatch(/ambiguous/i);

      // None of the rejected edits mutated the working copy.
      expect(sandbox.editedPaths()).toEqual([]);
      expect(sandbox.revision()).toBe(revisionBefore);

      // Apply the correct fix.
      const applied = sandbox.applyEdits([
        {
          path: "src/calculator.mjs",
          oldText: BUGGY_ADD,
          newText: FIXED_ADD
        }
      ]);
      expect(applied.applied).toBe(true);
      expect(applied.changedPaths).toEqual(["src/calculator.mjs"]);
      expect(applied.rejected).toEqual([]);

      const revisionAfter = sandbox.revision();
      expect(revisionAfter).not.toBe(revisionBefore);
      expect(applied.revision).toBe(revisionAfter);
      expect(sandbox.editedPaths()).toEqual(["src/calculator.mjs"]);
      expect(sandbox.readFile("src/calculator.mjs")).toContain(FIXED_ADD);

      const passing = await sandbox.runTests();
      expect(passing.exitCode).toBe(0);
    } finally {
      await sandbox.dispose();
    }
  });
});
