import { describe, expect, it } from "vitest";
import type { ArtifactReference } from "../server/artifacts/index.js";
import { createHash } from "node:crypto";
import { createRepairToolbox } from "../server/repair/tools.js";
import type {
  RepairSandbox,
  SandboxApplyResult,
  SandboxEdit,
  SandboxFileInfo
} from "../server/repair/index.js";

function fakeArtifactStore() {
  const entries = new Map<string, string>();
  return {
    entries,
    async putText(text: string): Promise<ArtifactReference> {
      const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
      entries.set(sha256, text);
      return { sha256, bytes: Buffer.byteLength(text, "utf8"), mediaType: "text/plain" };
    },
    async readText(sha256: string): Promise<string> {
      return entries.get(sha256) ?? "";
    }
  };
}

function fakeSandbox(
  files: Record<string, string>,
  testRun: { exitCode: number; stdout: string }
): RepairSandbox & { applied: SandboxEdit[][] } {
  const content = new Map(Object.entries(files));
  const applied: SandboxEdit[][] = [];
  let rev = "0".repeat(64);
  return {
    id: "fake",
    dir: "/tmp/fake",
    allowlistedPaths: Object.keys(files),
    protectedPaths: [],
    applied,
    revision: () => rev,
    listFiles: (): readonly SandboxFileInfo[] =>
      [...content.entries()].map(([path, text]) => ({
        path,
        lines: text.split("\n").length,
        bytes: Buffer.byteLength(text, "utf8")
      })),
    readFile: (path: string): string => {
      if (!content.has(path)) throw new Error("not allowlisted");
      return content.get(path)!;
    },
    applyEdits: (edits: readonly SandboxEdit[]): SandboxApplyResult => {
      applied.push([...edits]);
      rev = createHash("sha256").update(rev + JSON.stringify(edits)).digest("hex");
      return { applied: true, revision: rev, changedPaths: edits.map((e) => e.path), rejected: [] };
    },
    runTests: async () => ({ exitCode: testRun.exitCode, durationMs: 1, stdout: testRun.stdout }),
    editedPaths: () => [],
    dispose: async () => undefined
  };
}

describe("repair toolbox", () => {
  it("list_files reports the sandbox files", async () => {
    const toolbox = createRepairToolbox(
      fakeSandbox({ "a.ts": "one\ntwo\n" }, { exitCode: 0, stdout: "" }),
      fakeArtifactStore()
    );
    const parsed = JSON.parse(await toolbox.execute("list_files", "{}"));
    expect(parsed.files[0].path).toBe("a.ts");
    expect(parsed.files[0].lines).toBe(3);
  });

  it("read_file returns the requested slice and errors on bad path/range", async () => {
    const toolbox = createRepairToolbox(
      fakeSandbox({ "a.ts": "l1\nl2\nl3\nl4" }, { exitCode: 0, stdout: "" }),
      fakeArtifactStore()
    );
    const slice = JSON.parse(
      await toolbox.execute("read_file", JSON.stringify({ path: "a.ts", start_line: 2, end_line: 3 }))
    );
    expect(slice.content).toBe("l2\nl3");

    const missing = JSON.parse(
      await toolbox.execute("read_file", JSON.stringify({ path: "nope.ts", start_line: 1, end_line: 1 }))
    );
    expect(missing.error).toBe("FILE_NOT_ALLOWLISTED");

    const badRange = JSON.parse(
      await toolbox.execute("read_file", JSON.stringify({ path: "a.ts", start_line: 10, end_line: 11 }))
    );
    expect(badRange.error).toBe("INVALID_RANGE");
  });

  it("apply_patch forwards edits and reports the new revision", async () => {
    const sandbox = fakeSandbox({ "a.ts": "x" }, { exitCode: 0, stdout: "" });
    const toolbox = createRepairToolbox(sandbox, fakeArtifactStore());
    const result = JSON.parse(
      await toolbox.execute(
        "apply_patch",
        JSON.stringify({ edits: [{ path: "a.ts", old_text: "x", new_text: "y" }] })
      )
    );
    expect(result.applied).toBe(true);
    expect(result.changedPaths).toEqual(["a.ts"]);
    expect(sandbox.applied[0][0]).toEqual({ path: "a.ts", oldText: "x", newText: "y" });
  });

  it("run_tests reduces the log, stays within 16 KB, and reports pass state", async () => {
    const bigLog = "FAIL suite/x\nAssertionError: boom\n" + "noise line\n".repeat(50_000);
    const store = fakeArtifactStore();
    const toolbox = createRepairToolbox(
      fakeSandbox({ "a.ts": "x" }, { exitCode: 1, stdout: bigLog }),
      store
    );
    const raw = await toolbox.execute("run_tests", "{}");
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(16 * 1024);
    const parsed = JSON.parse(raw);
    expect(parsed.passed).toBe(false);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(store.entries.size).toBe(1);
  });

  it("throws on unknown tool and invalid arguments", async () => {
    const toolbox = createRepairToolbox(
      fakeSandbox({ "a.ts": "x" }, { exitCode: 0, stdout: "" }),
      fakeArtifactStore()
    );
    await expect(toolbox.execute("nope", "{}")).rejects.toThrow();
    await expect(
      toolbox.execute("read_file", JSON.stringify({ path: "a.ts" }))
    ).rejects.toThrow();
  });
});
