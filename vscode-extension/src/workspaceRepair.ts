import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { GovernorApiError, GovernorHttpClient } from "./apiClient";
import { parseRepairResult, type RepairResult } from "./repairClient";

export type RepositoryFile = { path: string; content: string };
export type RepositoryRepairRequest = {
  requestId: string;
  files: RepositoryFile[];
  editablePaths: string[];
  testPaths: string[];
  budgetUsd: string;
  maxResponses?: number;
};
export type RepositoryChange = { path: string; before: string; after: string };
export type RepositoryRepairResult = {
  requestId: string;
  jobId?: string;
  status: "completed" | "already_passing" | "baseline_failed";
  model: string;
  rateCardVersion: string;
  baseline: { exitCode: number; durationMs: number; stdout: string };
  result: RepairResult | null;
  changes: RepositoryChange[];
  testPaths: string[];
};
export type RepositoryRun = {
  requestId: string;
  jobId?: string;
  status: "running" | "completed" | "failed";
  result?: RepositoryRepairResult;
  error?: string;
};

const MAX_FILES = 64;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_SNAPSHOT_BYTES = 128 * 1024;
const OMIT_DIRECTORIES = new Set([
  "node_modules", "vendor", "dist", "build", "out", "coverage", "target",
  "secrets", "credentials", "keys", "certs"
]);
const CODE_EXTENSION = /\.(?:[cm]?js|[cm]?ts)$/;
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function isRepositoryFilePath(value: string): boolean {
  if (!value || value.length > 240 || path.posix.isAbsolute(value) || /[\\\x00-\x1f\x7f:]/.test(value)) return false;
  const parts = value.split("/");
  if (parts.some((part) => !/^[A-Za-z0-9_][A-Za-z0-9_. -]*$/.test(part) || /[. ]$/.test(part) || OMIT_DIRECTORIES.has(part.toLowerCase()) || /^id_(rsa|ed25519)(\.|$)/i.test(part))) return false;
  const name = parts.at(-1)!;
  if (/(?:^|[._-])(?:env|credentials?|secrets?|tokens?|api[-_]?keys?|private[-_]?keys?)(?:[._-]|$)/i.test(name)) return false;
  return CODE_EXTENSION.test(name) || /\.(?:json|md|txt)$/.test(name);
}

export function isRepositoryTestPath(value: string): boolean {
  return isRepositoryFilePath(value) && CODE_EXTENSION.test(value) && TEST_PATH.test(value);
}

export function isRepositorySourcePath(value: string): boolean {
  return isRepositoryFilePath(value) && CODE_EXTENSION.test(value) && !isRepositoryTestPath(value);
}

export async function discoverRepositoryFiles(root: string): Promise<string[]> {
  const canonicalRoot = await realpath(root);
  const result: string[] = [];
  let visited = 0;
  async function walk(directory: string, prefix: string, depth: number): Promise<void> {
    if (depth > 12) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 10_000) throw new Error("This folder is too large to scan. Open a smaller package folder for repair.");
      if (entry.name.startsWith(".") || OMIT_DIRECTORIES.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative, depth + 1);
      else if (entry.isFile() && isRepositoryFilePath(relative)) result.push(relative);
    }
  }
  await walk(canonicalRoot, "", 0);
  return result.sort();
}

export async function readRepositoryFile(root: string, relative: string): Promise<string> {
  if (!isRepositoryFilePath(relative)) throw new Error(`Unsupported repair path: ${relative}`);
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Repair files must be regular files without symbolic links: ${relative}`);
    }
  }
  const resolved = await realpath(current);
  if (!resolved.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error(`Repair file escaped the workspace: ${relative}`);
  const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`Repair files must be at most 64 KiB: ${relative}`);
    const bytes = await file.readFile();
    if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) throw new Error(`Repair file is too large or binary: ${relative}`);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error(`Repair files must use UTF-8: ${relative}`); }
  } finally { await file.close(); }
}

export async function snapshotRepository(root: string, paths: readonly string[]): Promise<RepositoryFile[]> {
  const spellings = new Map<string, string>();
  for (const relative of paths) {
    const parts = relative.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      const prefix = parts.slice(0, index).join("/");
      const existing = spellings.get(prefix.toLowerCase());
      if (existing && existing !== prefix) throw new Error("Selected paths differ only by letter case. Use one consistent spelling for each directory and file.");
      spellings.set(prefix.toLowerCase(), prefix);
    }
  }
  if (paths.length < 2 || paths.length > MAX_FILES || new Set(paths).size !== paths.length) {
    throw new Error("Select 2–64 distinct source, test, and context files.");
  }
  const files: RepositoryFile[] = [];
  let total = 0;
  for (const relative of paths) {
    const content = await readRepositoryFile(root, relative);
    total += Buffer.byteLength(content, "utf8");
    if (total > MAX_SNAPSHOT_BYTES) throw new Error("The selected files exceed 128 KiB. Select fewer files or a smaller package.");
    files.push({ path: relative, content });
  }
  if (Buffer.byteLength(JSON.stringify(files), "utf8") > 230 * 1024) {
    throw new Error("The selected files exceed the request size limit after encoding.");
  }
  return files;
}

function invalid(message: string): never {
  throw new GovernorApiError(message, 200, "INVALID_RESPONSE");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Governor returned an invalid repository repair record.");
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(`Governor returned an invalid ${label}.`);
  return value;
}

export function parseRepositoryRun(value: unknown, request: RepositoryRepairRequest): RepositoryRun {
  const raw = record(value);
  if (raw.requestId !== request.requestId || !UUID.test(request.requestId)) invalid("Governor returned a different repository repair.");
  if (raw.status !== "running" && raw.status !== "completed" && raw.status !== "failed") invalid("Governor returned an invalid repair status.");
  const run: RepositoryRun = { requestId: request.requestId, status: raw.status };
  if (raw.jobId !== undefined) run.jobId = string(raw.jobId, "repair job ID");
  if (raw.error !== undefined) run.error = string(raw.error, "repair error");
  if (raw.status === "failed" && !run.error) invalid("Failed repository repair is missing its error.");
  if (raw.result !== undefined) {
    const result = record(raw.result);
    if (result.requestId !== request.requestId) invalid("Governor returned a different repair result.");
    if (result.status !== "completed" && result.status !== "already_passing" && result.status !== "baseline_failed") invalid("Governor returned an invalid result status.");
    if (!Array.isArray(result.testPaths) || JSON.stringify(result.testPaths) !== JSON.stringify(request.testPaths)) invalid("Governor changed the approved test selection.");
    const baseline = record(result.baseline);
    if (!Number.isSafeInteger(baseline.exitCode) || typeof baseline.durationMs !== "number" || !Number.isFinite(baseline.durationMs) || baseline.durationMs < 0) invalid("Governor returned invalid baseline test results.");
    if (!Array.isArray(result.changes) || result.changes.length > request.editablePaths.length) invalid("Governor returned invalid repair changes.");
    const seen = new Set<string>();
    const originals = new Map(request.files.map((file) => [file.path, file.content]));
    const changes = result.changes.map((value) => {
      const change = record(value);
      const filePath = string(change.path, "change path");
      if (!request.editablePaths.includes(filePath) || seen.has(filePath) || !isRepositorySourcePath(filePath)) invalid("Governor returned a change outside the approved source files.");
      const before = string(change.before, "original source");
      const after = string(change.after, "repaired source");
      if (before !== originals.get(filePath)) invalid("Governor returned a change from a different source snapshot.");
      if (Buffer.byteLength(after, "utf8") > MAX_FILE_BYTES || after.includes("\0")) invalid("Governor returned an oversized or binary source change.");
      seen.add(filePath);
      return { path: filePath, before, after };
    });
    const repair = result.result === null ? null : parseRepairResult(result.result);
    if (raw.status === "completed" && result.status === "completed" && !repair) invalid("A completed repair is missing its evaluation.");
    if (result.status !== "completed" && (repair !== null || changes.length !== 0)) invalid("A skipped repair cannot include generated changes.");
    run.result = {
      requestId: request.requestId, status: result.status,
      ...(result.jobId === undefined ? {} : { jobId: string(result.jobId, "repair job ID") }),
      model: string(result.model, "model"), rateCardVersion: string(result.rateCardVersion, "rate card"),
      baseline: { exitCode: baseline.exitCode as number, durationMs: baseline.durationMs, stdout: string(baseline.stdout, "baseline output") },
      result: repair, changes, testPaths: [...request.testPaths]
    };
  }
  if (raw.status === "completed" && !run.result) invalid("Completed repository repair is missing its result.");
  if (raw.status === "running" && run.result !== undefined) invalid("Running repository repair cannot include a final result.");
  return run;
}

export class RepositoryRepairClient {
  constructor(private readonly http: GovernorHttpClient) {}
  async start(request: RepositoryRepairRequest): Promise<RepositoryRun> {
    return parseRepositoryRun(await this.http.request("/api/repair/repository/runs", {
      method: "POST", body: JSON.stringify(request)
    }), request);
  }
  async get(request: RepositoryRepairRequest, signal?: AbortSignal): Promise<RepositoryRun> {
    return parseRepositoryRun(await this.http.request(`/api/repair/repository/runs/${encodeURIComponent(request.requestId)}`, { method: "GET" }, signal), request);
  }
}
