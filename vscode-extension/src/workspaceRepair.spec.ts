import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GovernorHttpClient } from "./apiClient";
import {
  discoverRepositoryFiles, isRepositoryFilePath, isRepositorySourcePath,
  isRepositoryTestPath, parseRepositoryRun, readRepositoryFile,
  RepositoryRepairClient, snapshotRepository, type RepositoryRepairRequest
} from "./workspaceRepair";

const roots: string[] = [];
async function folder(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "governor-workspace-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function request(): RepositoryRepairRequest {
  return {
    requestId: "832c8bfc-0c9b-43c8-a45d-521ae8cf8cd8",
    files: [{ path: "src/sum.ts", content: "export const sum = (a: number, b: number) => a - b;" }, { path: "test/sum.test.ts", content: "test source" }],
    editablePaths: ["src/sum.ts"], testPaths: ["test/sum.test.ts"], budgetUsd: "1.00"
  };
}
function completed(input = request()) {
  return {
    requestId: input.requestId, status: "completed",
    result: {
      requestId: input.requestId, status: "completed", model: "test-model", rateCardVersion: "test-rates",
      baseline: { exitCode: 1, durationMs: 12, stdout: "assertion failed" },
      result: {
        status: "not_repaired", reason: "WORK_DENIED", finalText: null, evaluation: null,
        toolCalls: 2, revision: "revision", settledMicroUsd: 123, trace: []
      },
      changes: [{ path: "src/sum.ts", before: input.files[0]!.content, after: "export const sum = (a: number, b: number) => a + b;" }],
      testPaths: input.testPaths
    }
  };
}

describe("workspace snapshot", () => {
  it.each(["../secret.ts", "/tmp/source.js", "src/../secret.ts", "src\\file.ts", ".env", "src/.private.ts", "keys/source.ts", "api-key.json", "credentials.json", "file\u0000.js", "a:b.ts", "a//b.ts", "node_modules/dep/index.js", "source.TS", "source .ts/../bad.ts", "café.ts", "folder./source.ts"])("rejects unsafe path %s", (file) => {
    expect(isRepositoryFilePath(file)).toBe(false);
  });

  it("recognizes native test naming and excludes tests from editable sources", () => {
    for (const file of ["test/example.ts", "src/example.test.mjs", "tests/math.spec.cts"]) {
      expect(isRepositoryTestPath(file)).toBe(true);
      expect(isRepositorySourcePath(file)).toBe(false);
    }
    expect(isRepositorySourcePath("src/example.ts")).toBe(true);
    expect(isRepositoryFilePath("package.json")).toBe(true);
    expect(isRepositorySourcePath("package.json")).toBe(false);
  });

  it("discovers source and tests without traversing excluded folders or symlinks", async () => {
    const root = await folder();
    const outside = await folder();
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "node_modules"));
    await mkdir(path.join(root, ".git"));
    await writeFile(path.join(root, "src/main.ts"), "source");
    await writeFile(path.join(root, "src/main.test.ts"), "test");
    await writeFile(path.join(root, "credentials.json"), "secret");
    await writeFile(path.join(root, "node_modules/dep.js"), "secret");
    await writeFile(path.join(outside, "external.ts"), "secret");
    await symlink(outside, path.join(root, "linked"));
    await symlink(path.join(outside, "external.ts"), path.join(root, "src/link.ts"));
    expect(await discoverRepositoryFiles(root)).toEqual(["src/main.test.ts", "src/main.ts"]);
  });

  it("refuses direct and parent symlinks when reading a selected file", async () => {
    const root = await folder();
    const outside = await folder();
    await writeFile(path.join(outside, "source.ts"), "secret");
    await symlink(outside, path.join(root, "src"));
    await symlink(path.join(outside, "source.ts"), path.join(root, "link.ts"));
    await expect(readRepositoryFile(root, "src/source.ts")).rejects.toThrow("symbolic links");
    await expect(readRepositoryFile(root, "link.ts")).rejects.toThrow("symbolic links");
  });

  it("rejects binary, invalid UTF-8, and oversized files", async () => {
    const root = await folder();
    await writeFile(path.join(root, "binary.js"), Buffer.from([65, 0, 66]));
    await writeFile(path.join(root, "bad.js"), Buffer.from([0xff, 0xfe]));
    await writeFile(path.join(root, "large.ts"), "x".repeat(65 * 1024));
    await expect(readRepositoryFile(root, "binary.js")).rejects.toThrow("binary");
    await expect(readRepositoryFile(root, "bad.js")).rejects.toThrow("UTF-8");
    await expect(readRepositoryFile(root, "large.ts")).rejects.toThrow("64 KiB");
  });

  it("snapshots exact selected files without altering the project", async () => {
    const root = await folder();
    await writeFile(path.join(root, "app.js"), "source\n");
    await writeFile(path.join(root, "app.test.js"), "test\n");
    await writeFile(path.join(root, "ignored.json"), "private");
    expect(await snapshotRepository(root, ["app.js", "app.test.js"])).toEqual([
      { path: "app.js", content: "source\n" }, { path: "app.test.js", content: "test\n" }
    ]);
    expect(await readRepositoryFile(root, "ignored.json")).toBe("private");
  });

  it("rejects case-colliding directory prefixes before reading files", async () => {
    const root = await folder();
    await expect(snapshotRepository(root, ["Src/first.ts", "src/second.ts"])).rejects.toThrow("letter case");
  });

  it("bounds the combined snapshot and rejects duplicate paths", async () => {
    const root = await folder();
    const paths = ["a.ts", "b.ts", "c.ts"];
    await Promise.all(paths.map((file) => writeFile(path.join(root, file), "x".repeat(48 * 1024))));
    await expect(snapshotRepository(root, paths)).rejects.toThrow("128 KiB");
    await expect(snapshotRepository(root, ["a.ts", "a.ts"])).rejects.toThrow("distinct");
  });
});

describe("repository repair receipts", () => {
  it("retains partial patches and never labels them as repaired", () => {
    const parsed = parseRepositoryRun(completed(), request());
    expect(parsed.result?.result?.status).toBe("not_repaired");
    expect(parsed.result?.changes).toHaveLength(1);
  });

  it("recovers interrupted results with partial changes and no final response", () => {
    const raw = completed();
    const interrupted = { ...raw, status: "failed", error: "Service restarted; some reservations remain held", result: { ...raw.result, result: null } };
    expect(parseRepositoryRun(interrupted, request()).result?.changes).toHaveLength(1);
  });

  it("rejects a different run or changed test selection", () => {
    const raw = completed();
    expect(() => parseRepositoryRun({ ...raw, requestId: "other" }, request())).toThrow("different");
    expect(() => parseRepositoryRun({ ...raw, result: { ...raw.result, testPaths: ["other.test.ts"] } }, request())).toThrow("test selection");
  });

  it("rejects writes to tests, other files, and stale original source", () => {
    const raw = completed();
    for (const change of [
      { path: "test/sum.test.ts", before: "test source", after: "tampered test" },
      { path: "../../outside.ts", before: "", after: "outside" },
      { path: "src/sum.ts", before: "different source", after: "patch" }
    ]) {
      expect(() => parseRepositoryRun({ ...raw, result: { ...raw.result, changes: [change] } }, request())).toThrow();
    }
  });

  it("rejects duplicate or oversized changes and inconsistent status envelopes", () => {
    const raw = completed();
    expect(() => parseRepositoryRun({ ...raw, result: { ...raw.result, changes: [...raw.result.changes, ...raw.result.changes] } }, request())).toThrow();
    expect(() => parseRepositoryRun({ ...raw, result: { ...raw.result, changes: [{ ...raw.result.changes[0], after: "x".repeat(65 * 1024) }] } }, request())).toThrow();
    expect(() => parseRepositoryRun({ ...raw, status: "running" }, request())).toThrow();
    expect(() => parseRepositoryRun({ requestId: request().requestId, status: "completed" }, request())).toThrow();
  });

  it("checks an existing run with GET and never resubmits after transport failure", async () => {
    const input = request();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ requestId: input.requestId, status: "running" })));
    const client = new RepositoryRepairClient(new GovernorHttpClient({ baseUrl: "http://127.0.0.1:8787", fetchImpl }));
    await expect(client.start(input)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(await client.get(input)).toEqual({ requestId: input.requestId, status: "running" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe("GET");
    expect(fetchImpl.mock.calls[1]?.[0]).toContain(input.requestId);
  });
});
