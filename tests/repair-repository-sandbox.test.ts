import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRepairSandbox, verifyFinalState } from "../server/repair/sandbox.js";
import type { RepairFixture, RepairSandbox } from "../server/repair/types.js";

const directories: string[] = [];
const sandboxes: RepairSandbox[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.dispose()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(
  files: Record<string, string>,
  editable: string[],
  tests: string[],
  maxEditFiles = editable.length
): Promise<RepairFixture> {
  const rootDir = await mkdtemp(join(tmpdir(), "governor-repository-test-"));
  directories.push(rootDir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(rootDir, path)), { recursive: true });
    await writeFile(join(rootDir, path), content, "utf8");
  }
  const readonlyPaths = Object.keys(files).filter((path) => !editable.includes(path));
  return {
    id: "repository-test", rootDir, allowlistedPaths: editable,
    protectedPaths: readonlyPaths, readonlyPaths,
    testCommand: ["node", "--test", ...tests], maxEditFiles
  };
}

async function open(input: RepairFixture): Promise<RepairSandbox> {
  const sandbox = await createRepairSandbox(input);
  sandboxes.push(sandbox);
  return sandbox;
}

describe("repository snapshots", () => {
  it("runs only selected tests and reads protected context without allowing edits", async () => {
    const input = await fixture({
      "package.json": '{"type":"module"}',
      "src/math.mjs": "export const sum = (a, b) => a + b;",
      "test/chosen.test.mjs": "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {sum} from '../src/math.mjs'; test('chosen test', () => assert.equal(sum(1, 2), 3));",
      "test/unrelated.test.mjs": "throw new Error('unrelated test must not run');"
    }, ["src/math.mjs"], ["test/chosen.test.mjs"]);
    const sandbox = await open(input);
    expect(sandbox.readFile("test/chosen.test.mjs")).toContain("chosen test");
    expect(sandbox.readFile("package.json")).toContain("module");
    expect(sandbox.listFiles().find((file) => file.path === "test/chosen.test.mjs")?.editable).toBe(false);
    expect(sandbox.listFiles().find((file) => file.path === "src/math.mjs")?.editable).toBe(true);
    const rejected = sandbox.applyEdits([
      { path: "src/math.mjs", oldText: "a + b", newText: "a - b" },
      { path: "test/chosen.test.mjs", oldText: "sum(1, 2), 3", newText: "sum(1, 2), -1" }
    ]);
    expect(rejected.applied).toBe(false);
    expect(sandbox.editedPaths()).toEqual([]);
    const result = await sandbox.runTests();
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).toContain("chosen test");
    expect(result.stdout).not.toContain("unrelated test must not run");
    const verified = await verifyFinalState(input, new Map([["src/math.mjs", sandbox.readFile("src/math.mjs")]]));
    expect(verified.exitCode, verified.stdout).toBe(0);
  });

  it("runs a selected TypeScript test and verifies an actual source repair", async () => {
    const input = await fixture({
      "package.json": '{"type":"module"}',
      "src/math.ts": "export function sum(a: number, b: number): number { return a - b; }",
      "test/math.test.ts": "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {sum} from '../src/math.ts'; test('typed sum', () => assert.equal(sum(2, 4), 6));"
    }, ["src/math.ts"], ["test/math.test.ts"]);
    const sandbox = await open(input);
    expect((await sandbox.runTests()).exitCode).toBe(1);
    expect(sandbox.applyEdits([{ path: "src/math.ts", oldText: "a - b", newText: "a + b" }]).applied).toBe(true);
    const result = await sandbox.runTests();
    expect(result.exitCode, result.stdout).toBe(0);
    const verified = await verifyFinalState(input, new Map([["src/math.ts", sandbox.readFile("src/math.ts")]]));
    expect(verified.exitCode, verified.stdout).toBe(0);
  });

  it("enforces the cumulative edited-file limit before changing any files", async () => {
    const input = await fixture({ "one.mjs": "const one = 1;", "two.mjs": "const two = 2;" }, ["one.mjs", "two.mjs"], [], 1);
    const sandbox = await open(input);
    expect(sandbox.applyEdits([{ path: "one.mjs", oldText: "1", newText: "3" }]).applied).toBe(true);
    const second = sandbox.applyEdits([{ path: "two.mjs", oldText: "2", newText: "4" }]);
    expect(second.applied).toBe(false);
    expect(second.rejected[0].reason).toContain("maxEditFiles");
    expect(sandbox.readFile("two.mjs")).toBe("const two = 2;");
    const replace = sandbox.applyEdits([
      { path: "one.mjs", oldText: "3", newText: "1" },
      { path: "two.mjs", oldText: "2", newText: "4" }
    ]);
    expect(replace.applied).toBe(true);
    expect(sandbox.editedPaths()).toEqual(["two.mjs"]);
    await expect(verifyFinalState(input, new Map([["one.mjs", "changed"], ["two.mjs", "changed"]]))).rejects.toThrow("maxEditFiles");
  });

  it("rejects oversize generated source before writing or final verification", async () => {
    const input = await fixture({ "source.mjs": "original" }, ["source.mjs"], []);
    const sandbox = await open(input);
    const large = "x".repeat(64 * 1024 + 1);
    const result = sandbox.applyEdits([{ path: "source.mjs", oldText: "original", newText: large }]);
    expect(result.applied).toBe(false);
    expect(result.rejected[0].reason).toContain("64 KiB");
    expect(sandbox.readFile("source.mjs")).toBe("original");
    await expect(verifyFinalState(input, new Map([["source.mjs", large]]))).rejects.toThrow("64 KiB");
  });

  it("bounds the combined source size across individually valid files", async () => {
    const content = `unique${"x".repeat(41_000)}`;
    const input = await fixture({ "a.mjs": content, "b.mjs": content, "c.mjs": content }, ["a.mjs", "b.mjs", "c.mjs"], []);
    const sandbox = await open(input);
    const result = sandbox.applyEdits([{ path: "a.mjs", oldText: "unique", newText: "y".repeat(10_000) }]);
    expect(result.applied).toBe(false);
    expect(result.rejected[0].reason).toContain("128 KiB");
    expect(sandbox.editedPaths()).toEqual([]);
  });

  it("rejects path overlap, case ambiguity, missing files, and editable tests", async () => {
    const input = await fixture({ "source.mjs": "original", "test.mjs": "test" }, ["source.mjs"], ["test.mjs"]);
    await expect(createRepairSandbox({ ...input, readonlyPaths: ["source.mjs"] })).rejects.toThrow("overlap");
    await expect(createRepairSandbox({ ...input, protectedPaths: ["SOURCE.mjs"] })).rejects.toThrow("case");
    await expect(createRepairSandbox({ ...input, readonlyPaths: ["missing.mjs"] })).rejects.toThrow("regular snapshot file");
    await expect(createRepairSandbox({ ...input, testCommand: ["node", "--test", "source.mjs"] })).rejects.toThrow("protected snapshot files");
    await expect(verifyFinalState(input, new Map([["test.mjs", "changed"]]))).rejects.toThrow("editable snapshot files");
  });

  it("rejects an oversize input snapshot before creating a runnable copy", async () => {
    const input = await fixture({ "source.mjs": "x".repeat(64 * 1024 + 1) }, ["source.mjs"], []);
    await expect(createRepairSandbox(input)).rejects.toThrow("limit");
  });
});
