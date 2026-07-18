import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  RepairFixture,
  RepairSandbox,
  SandboxApplyResult,
  SandboxEdit,
  SandboxFileInfo,
  SandboxTestRun
} from "./types.js";

/**
 * Hard cap on the captured stdout+stderr returned by {@link RepairSandbox.runTests}.
 * Mirrors `MAX_TEST_LOG_BYTES` from the governor's log reducer, but the sandbox
 * is intentionally kept dependency-free of the governor/artifact layers.
 */
const MAX_TEST_LOG_BYTES = 4 * 1024 * 1024;

/** Hard wall-clock timeout for a single pinned test run. */
const TEST_TIMEOUT_MS = 30_000;

/** Exit code reported when the test process is killed by our timeout or an abort. */
const TIMEOUT_EXIT_CODE = 124;

function cancellationError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("The sandbox operation was cancelled.");
  error.name = "AbortError";
  return error;
}

function revisionOf(entries: Iterable<readonly [string, string]>): string {
  const hash = createHash("sha256");
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [path, content] of sorted) {
    hash.update(path);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function countLines(content: string): number {
  return content.split("\n").length;
}

/** Concatenate stdout/stderr chunks, hard-capping total retained bytes. */
class BoundedCapture {
  private readonly chunks: Buffer[] = [];
  private total = 0;

  push(chunk: Buffer): void {
    if (this.total >= MAX_TEST_LOG_BYTES) {
      return;
    }
    const remaining = MAX_TEST_LOG_BYTES - this.total;
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    this.chunks.push(slice);
    this.total += slice.length;
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.total).toString("utf8");
  }
}

/**
 * Spawn the pinned test command in `dir` with a locked-down environment and a
 * hard wall-clock timeout, returning bounded output. Shared by the live sandbox
 * (`runTests`) and the sealed evaluator's fresh checkout ({@link verifyFinalState})
 * so both execute tests through the exact same, dependency-free path.
 */
function runPinnedTests(
  dir: string,
  testCommand: readonly string[],
  signal?: AbortSignal
): Promise<SandboxTestRun> {
  const [command, ...args] = testCommand;
  const capture = new BoundedCapture();
  const start = Date.now();

  return new Promise<SandboxTestRun>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: dir,
      shell: false,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_OPTIONS: ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let settled = false;
    let killedByTimeout = false;
    let killedByAbort = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };
    const finish = (run: SandboxTestRun): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(run);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGKILL");
    }, TEST_TIMEOUT_MS);

    const onAbort = (): void => {
      killedByAbort = true;
      child.kill("SIGKILL");
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => capture.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture.push(chunk));

    child.on("error", (error) => fail(error));
    child.on("close", (code) => {
      if (killedByAbort && signal) {
        fail(cancellationError(signal));
        return;
      }
      finish({
        exitCode: killedByTimeout ? TIMEOUT_EXIT_CODE : code ?? TIMEOUT_EXIT_CODE,
        durationMs: Date.now() - start,
        stdout: capture.toString()
      });
    });
  });
}

/**
 * Sealed final verification in a throwaway checkout. Copies the PRISTINE
 * fixture template into a brand-new temp dir, overlays ONLY the agent's final
 * allowlisted file contents, then runs the pinned tests there. Anything the
 * agent may have touched outside the allowlist inside its own sandbox (protected
 * paths, non-allowlisted files, stray writes) is discarded, so a green result
 * cannot be manufactured by tampering with the sandbox working tree.
 */
export async function verifyFinalState(
  fixture: RepairFixture,
  finalContents: ReadonlyMap<string, string>,
  signal?: AbortSignal
): Promise<SandboxTestRun> {
  const dir = await mkdtemp(join(tmpdir(), `repair-verify-${fixture.id}-`));
  try {
    await cp(fixture.rootDir, dir, { recursive: true });
    for (const path of fixture.allowlistedPaths) {
      const content = finalContents.get(path);
      if (content !== undefined) {
        writeFileSync(join(dir, path), content, "utf8");
      }
    }
    return await runPinnedTests(dir, fixture.testCommand, signal);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function createRepairSandbox(
  fixture: RepairFixture
): Promise<RepairSandbox> {
  const allowlistedPaths = [...fixture.allowlistedPaths];
  const protectedPaths = [...fixture.protectedPaths];

  const dir = await mkdtemp(join(tmpdir(), `repair-${fixture.id}-`));
  await cp(fixture.rootDir, dir, { recursive: true });

  const originalContent = new Map<string, string>();
  const currentContent = new Map<string, string>();
  for (const path of allowlistedPaths) {
    const content = await readFile(join(dir, path), "utf8");
    originalContent.set(path, content);
    currentContent.set(path, content);
  }

  const id = randomUUID();

  function revision(): string {
    return revisionOf(currentContent.entries());
  }

  function listFiles(): readonly SandboxFileInfo[] {
    return allowlistedPaths.map((path) => {
      const content = currentContent.get(path) as string;
      return {
        path,
        lines: countLines(content),
        bytes: Buffer.byteLength(content, "utf8")
      };
    });
  }

  function readFileContent(path: string): string {
    if (!currentContent.has(path)) {
      throw new Error(`Path is not allowlisted: ${path}`);
    }
    return currentContent.get(path) as string;
  }

  function applyEdits(edits: readonly SandboxEdit[]): SandboxApplyResult {
    const rejected: { path: string; reason: string }[] = [];
    const staged = new Map<string, string>();

    for (const edit of edits) {
      if (!currentContent.has(edit.path)) {
        rejected.push({ path: edit.path, reason: "path is not allowlisted" });
        continue;
      }
      const base = staged.get(edit.path) ?? (currentContent.get(edit.path) as string);
      const firstIndex = base.indexOf(edit.oldText);
      if (firstIndex === -1) {
        rejected.push({ path: edit.path, reason: "oldText not found" });
        continue;
      }
      if (firstIndex !== base.lastIndexOf(edit.oldText)) {
        rejected.push({
          path: edit.path,
          reason: "oldText is ambiguous (occurs more than once)"
        });
        continue;
      }
      const next =
        base.slice(0, firstIndex) +
        edit.newText +
        base.slice(firstIndex + edit.oldText.length);
      staged.set(edit.path, next);
    }

    // All-or-nothing: if any edit was rejected, write nothing.
    if (rejected.length > 0) {
      return {
        applied: false,
        revision: revision(),
        changedPaths: [],
        rejected
      };
    }

    const changedPaths: string[] = [];
    for (const [path, content] of staged) {
      writeFileSync(join(dir, path), content, "utf8");
      currentContent.set(path, content);
      changedPaths.push(path);
    }

    return {
      applied: true,
      revision: revision(),
      changedPaths,
      rejected: []
    };
  }

  async function runTests(signal?: AbortSignal): Promise<SandboxTestRun> {
    return await runPinnedTests(dir, fixture.testCommand, signal);
  }

  function editedPaths(): readonly string[] {
    return allowlistedPaths.filter(
      (path) => currentContent.get(path) !== originalContent.get(path)
    );
  }

  async function dispose(): Promise<void> {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    id,
    dir,
    allowlistedPaths,
    protectedPaths,
    revision,
    listFiles,
    readFile: readFileContent,
    applyEdits,
    runTests,
    editedPaths,
    dispose
  };
}
