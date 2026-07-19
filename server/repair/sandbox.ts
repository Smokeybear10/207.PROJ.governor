import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, writeFileSync } from "node:fs";
import { cp, lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { prepareIsolatedTests, type IsolatedTestCommand } from "./isolation.js";

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
const MAX_SOURCE_FILE_BYTES = 64 * 1024;
const MAX_SNAPSHOT_BYTES = 128 * 1024;
const MAX_SNAPSHOT_FILES = 64;

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
 * Spawn the pinned test command in `dir` with a reduced environment and a
 * hard wall-clock timeout, returning bounded output. Shared by the live sandbox
 * (`runTests`) and the sealed evaluator's fresh checkout ({@link verifyFinalState})
 * so both execute tests through the exact same, dependency-free path.
 */
function runPinnedTests(
  dir: string,
  command: IsolatedTestCommand,
  signal?: AbortSignal
): Promise<SandboxTestRun> {
  const capture = new BoundedCapture();
  const start = Date.now();

  return new Promise<SandboxTestRun>((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancellationError(signal));
      return;
    }
    const child = spawn(command.executable, [...command.args], {
      cwd: dir,
      shell: false,
      windowsHide: true,
      env: command.env,
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
    const killTests = (): void => {
      if (!child.pid) return;
      // The OS profile denies process-fork, so no subprocess can escape this PID.
      child.kill("SIGKILL");
    };

    const timer = setTimeout(() => {
      killedByTimeout = true;
      killTests();
    }, TEST_TIMEOUT_MS);

    const onAbort = (): void => {
      killedByAbort = true;
      killTests();
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

function validRelativePath(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !isAbsolute(path) &&
    path.split("/").every((part) => /^[a-zA-Z0-9_][a-zA-Z0-9_. -]*$/.test(part) && !/[. ]$/.test(part));
}

async function validateFixture(fixture: RepairFixture): Promise<Map<string, number>> {
  if (!/^[a-zA-Z0-9_-]+$/.test(fixture.id)) throw new Error("Invalid repair fixture ID.");
  const readonlyPaths = fixture.readonlyPaths ?? [];
  const paths = [...fixture.allowlistedPaths, ...fixture.protectedPaths, ...readonlyPaths];
  if (!paths.every(validRelativePath)) throw new Error("Repair fixture paths must stay inside the working copy.");
  if (!Number.isSafeInteger(fixture.maxEditFiles) || fixture.maxEditFiles < 0 || fixture.maxEditFiles > fixture.allowlistedPaths.length) {
    throw new Error("maxEditFiles must be within the editable file count.");
  }
  for (const group of [fixture.allowlistedPaths, fixture.protectedPaths, readonlyPaths]) {
    if (new Set(group).size !== group.length) throw new Error("Repair fixture paths must not repeat.");
  }
  const editable = new Set(fixture.allowlistedPaths);
  if ([...fixture.protectedPaths, ...readonlyPaths].some((path) => editable.has(path))) {
    throw new Error("Editable paths cannot overlap protected or read-only paths.");
  }
  const unique = [...new Set(paths)];
  if (new Set(unique.map((path) => path.toLowerCase())).size !== unique.length) {
    throw new Error("Repair fixture paths cannot differ only in case.");
  }
  const files = await validateTree(fixture.rootDir);
  if (unique.some((path) => !files.has(path))) throw new Error("Every declared repair path must name a regular snapshot file.");
  if (fixture.testCommand.slice(2).some((path) => !fixture.protectedPaths.includes(path))) {
    throw new Error("Selected tests must be protected snapshot files.");
  }
  return files;
}

async function validateTree(root: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  const canonicalPaths = new Set<string>();
  let bytes = 0;
  let directories = 0;
  const visit = async (path: string): Promise<void> => {
    if (path && !validRelativePath(path)) throw new Error("Repair fixture paths must stay inside the working copy.");
    const canonical = path.toLowerCase();
    if (canonicalPaths.has(canonical)) throw new Error("Repair snapshot paths cannot differ only in case.");
    canonicalPaths.add(canonical);
    const entry = await lstat(join(root, path));
    if (entry.isSymbolicLink()) throw new Error("Repair fixtures cannot contain symbolic links.");
    if (entry.isDirectory()) {
      if (++directories > 128) throw new Error("Repair snapshot contains too many directories.");
      for (const name of await readdir(join(root, path))) await visit(path ? `${path}/${name}` : name);
      return;
    }
    if (!entry.isFile()) throw new Error("Repair fixtures may contain only regular files and directories.");
    bytes += entry.size;
    if (entry.size > MAX_SOURCE_FILE_BYTES || bytes > MAX_SNAPSHOT_BYTES || files.size >= MAX_SNAPSHOT_FILES) {
      throw new Error("Repair snapshot exceeds the 64-file, 64 KiB/file, or 128 KiB total limit.");
    }
    files.set(path, entry.size);
  };
  await visit("");
  return files;
}

function writeSourceFile(dir: string, path: string, content: string): void {
  let current = dir;
  for (const part of path.split("/").slice(0, -1)) {
    current = join(current, part);
    if (!lstatSync(current).isDirectory()) throw new Error("A repair file parent is not a directory.");
  }
  const descriptor = openSync(join(dir, path), constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  try {
    writeFileSync(descriptor, content, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Sealed final verification in a throwaway checkout. Copies the PRISTINE
 * fixture template into a brand-new temp dir, overlays ONLY the agent's final
 * allowlisted file contents, then runs the pinned tests there. Anything the
 * agent may have touched outside the allowlist inside its own sandbox (protected
 * paths, non-allowlisted files, stray writes) is discarded before execution.
 * Both verification and live test runs use the same read-only OS isolation.
 */
export async function verifyFinalState(
  fixture: RepairFixture,
  finalContents: ReadonlyMap<string, string>,
  signal?: AbortSignal
): Promise<SandboxTestRun> {
  const sizes = await validateFixture(fixture);
  let changedFiles = 0;
  let totalBytes = [...sizes.values()].reduce((total, bytes) => total + bytes, 0);
  for (const [path, content] of finalContents) {
    if (!fixture.allowlistedPaths.includes(path)) throw new Error("Final changes must target editable snapshot files.");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_SOURCE_FILE_BYTES) throw new Error("Final source exceeds the 64 KiB file limit.");
    totalBytes += bytes - (sizes.get(path) ?? 0);
    if (content !== await readFile(join(fixture.rootDir, path), "utf8")) changedFiles += 1;
  }
  if (totalBytes > MAX_SNAPSHOT_BYTES) throw new Error("Final snapshot exceeds the 128 KiB total limit.");
  if (changedFiles > fixture.maxEditFiles) throw new Error("Final changes exceed maxEditFiles.");
  const dir = await realpath(await mkdtemp(join(tmpdir(), `repair-verify-${fixture.id}-`)));
  try {
    await cp(fixture.rootDir, dir, { recursive: true });
    await validateTree(dir);
    for (const path of fixture.allowlistedPaths) {
      const content = finalContents.get(path);
      if (content !== undefined) {
        writeSourceFile(dir, path, content);
      }
    }
    const command = await prepareIsolatedTests(dir, fixture.testCommand);
    return await runPinnedTests(dir, command, signal);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function createRepairSandbox(
  fixture: RepairFixture
): Promise<RepairSandbox> {
  const sizes = await validateFixture(fixture);
  const allowlistedPaths = [...fixture.allowlistedPaths];
  const protectedPaths = [...fixture.protectedPaths];
  const readablePaths = [...allowlistedPaths, ...(fixture.readonlyPaths ?? [])];
  const editable = new Set(allowlistedPaths);

  const dir = await realpath(await mkdtemp(join(tmpdir(), `repair-${fixture.id}-`)));
  let command: IsolatedTestCommand;
  try {
    await cp(fixture.rootDir, dir, { recursive: true });
    await validateTree(dir);
    command = await prepareIsolatedTests(dir, fixture.testCommand);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  const originalContent = new Map<string, string>();
  const currentContent = new Map<string, string>();
  try {
    for (const path of readablePaths) {
      const content = await readFile(join(dir, path), "utf8");
      originalContent.set(path, content);
      currentContent.set(path, content);
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  const id = randomUUID();

  function revision(): string {
    return revisionOf(currentContent.entries());
  }

  function listFiles(): readonly SandboxFileInfo[] {
    return readablePaths.map((path) => {
      const content = currentContent.get(path) as string;
      return {
        path,
        lines: countLines(content),
        bytes: Buffer.byteLength(content, "utf8"),
        editable: editable.has(path)
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
      if (!editable.has(edit.path)) {
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
      if (Buffer.byteLength(next, "utf8") > MAX_SOURCE_FILE_BYTES) {
        rejected.push({ path: edit.path, reason: "source exceeds the 64 KiB file limit" });
        continue;
      }
      staged.set(edit.path, next);
    }

    const changed = allowlistedPaths.filter((path) => (staged.get(path) ?? currentContent.get(path)) !== originalContent.get(path));
    if (changed.length > fixture.maxEditFiles) {
      rejected.push({ path: changed.join(", "), reason: "changes exceed maxEditFiles" });
    }
    const totalBytes = [...sizes].reduce((total, [path, originalBytes]) => {
      const content = staged.get(path) ?? currentContent.get(path);
      return total + (content === undefined ? originalBytes : Buffer.byteLength(content, "utf8"));
    }, 0);
    if (totalBytes > MAX_SNAPSHOT_BYTES) {
      rejected.push({ path: [...staged.keys()].join(", "), reason: "snapshot exceeds the 128 KiB total limit" });
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
      writeSourceFile(dir, path, content);
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
    return await runPinnedTests(dir, command, signal);
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
    readonlyPaths: [...(fixture.readonlyPaths ?? [])],
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
