import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { GPT_5_4_MINI_STANDARD_RATE_CARD } from "../governor/index.js";
import { type GovernedJobService, parseUsdToMicroUsd } from "../jobs/index.js";
import { createRepairSandbox } from "./sandbox.js";
import type { RepairFixture, RepairSandbox, SandboxTestRun } from "./types.js";
import { runGovernedRepair, type GovernedRepairResult } from "./workflow.js";

export const MAX_REPOSITORY_BYTES = 128 * 1024;
const SOURCE_FILE = /\.(?:[cm]?js|[cm]?ts)$/;
const CONTEXT_FILE = /\.(?:json|md|txt)$/;
const EXCLUDED_PARTS = new Set(["node_modules", "vendor", "dist", "build", "out", "coverage", "target", "secrets", "credentials", "keys", "certs"]);

export function validRepositoryPath(path: string): boolean {
  return path.length <= 240 && !/(?:^|[._-])(?:env|credentials?|secrets?|tokens?|api[-_]?keys?|private[-_]?keys?)(?:[._-]|$)/i.test(path.split("/").at(-1)!) && path.split("/").every((part) =>
    /^[a-zA-Z0-9_][a-zA-Z0-9_. -]*$/.test(part) && !part.endsWith(".") && !part.endsWith(" ") &&
    !EXCLUDED_PARTS.has(part.toLowerCase()) && !/^id_(rsa|ed25519)(\.|$)/i.test(part)
  ) && (SOURCE_FILE.test(path) || CONTEXT_FILE.test(path));
}

function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]s$/i.test(path);
}

const relativePath = z.string().min(1).refine(validRepositoryPath, "Use a relative source or context file path, without hidden files or generated folders.");
export const repositoryRequestSchema = z.object({
  requestId: z.uuid().refine((value) => value === value.toLowerCase(), "Use a lowercase UUID."),
  files: z.array(z.object({
    path: relativePath,
    content: z.string().refine((text) => !text.includes("\0") && Buffer.byteLength(text, "utf8") <= 64 * 1024 && Buffer.from(text, "utf8").toString("utf8") === text,
      "Each file must be UTF-8 text no larger than 64 KiB.")
  }).strict()).min(2).max(64),
  editablePaths: z.array(relativePath).min(1).max(10),
  testPaths: z.array(relativePath).min(1).max(10),
  budgetUsd: z.string().regex(/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/).refine((value) => {
    const amount = parseUsdToMicroUsd(value);
    return amount >= 50_000 && amount <= 20_000_000;
  }, "Choose a repair budget between $0.05 and $20."),
  maxResponses: z.number().int().min(2).max(24).default(16)
}).strict().superRefine((value, ctx) => {
  const fail = (message: string): void => { ctx.addIssue({ code: "custom", message }); };
  if (value.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0) > MAX_REPOSITORY_BYTES) {
    fail("The approved snapshot must be no larger than 128 KiB.");
  }
  const paths = value.files.map((file) => file.path);
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) fail("Duplicate or case-colliding files are not supported.");
  const folded = paths.map((path) => path.toLowerCase());
  const prefixes = new Map<string, string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/");
      const previous = prefixes.get(prefix.toLowerCase());
      if (previous !== undefined && previous !== prefix) fail("Case-colliding directory names are not supported.");
      prefixes.set(prefix.toLowerCase(), prefix);
    }
  }
  if (folded.some((path) => folded.some((other) => other.startsWith(`${path}/`)))) fail("A file cannot also be a directory.");
  for (const selected of [value.editablePaths, value.testPaths]) {
    if (new Set(selected).size !== selected.length || selected.some((path) => !paths.includes(path))) fail("Selected paths must be unique files in the snapshot.");
  }
  if (value.testPaths.some((path) => !SOURCE_FILE.test(path))) fail("Tests must be Node JavaScript or TypeScript files.");
  if (value.editablePaths.some((path) => !SOURCE_FILE.test(path) || value.testPaths.includes(path) || isTestPath(path))) {
    fail("Only source files may be edited; test files and configuration stay read-only.");
  }
});

export type RepositoryRepairRequest = z.infer<typeof repositoryRequestSchema>;
export type RepositoryChange = { path: string; before: string; after: string };
export type RepositoryRepairResult = {
  requestId: string;
  status: "completed" | "already_passing" | "baseline_failed";
  model: string;
  rateCardVersion: string;
  baseline: SandboxTestRun;
  result: GovernedRepairResult | null;
  changes: RepositoryChange[];
  testPaths: string[];
  jobId?: string;
};

export function parseRepositoryRequest(value: unknown): RepositoryRepairRequest {
  const parsed = repositoryRequestSchema.safeParse(value);
  if (!parsed.success) throw new ApiError("INVALID_REPOSITORY_REPAIR", z.prettifyError(parsed.error), 400);
  return parsed.data;
}

export function repositoryFingerprint(request: RepositoryRepairRequest): string {
  return createHash("sha256").update(JSON.stringify({
    ...request,
    files: [...request.files].sort((a, b) => a.path.localeCompare(b.path)),
    editablePaths: [...request.editablePaths].sort(),
    testPaths: [...request.testPaths].sort()
  })).digest("hex");
}

export async function runRepositoryRepair(
  value: unknown,
  options: {
    service: GovernedJobService;
    signal?: AbortSignal;
    strategy?: "governed" | "hard_cap";
    onCheckpoint?: (result: RepositoryRepairResult) => void;
  }
): Promise<RepositoryRepairResult> {
  const request = parseRepositoryRequest(value);
  options.signal?.throwIfAborted();
  const rootDir = await mkdtemp(join(tmpdir(), "governor-repository-"));
  let sandbox: RepairSandbox | undefined;
  try {
    for (const file of request.files) {
      const target = join(rootDir, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.content, { flag: "wx", mode: 0o600 });
    }
    const readonlyPaths = request.files.map((file) => file.path).filter((path) => !request.editablePaths.includes(path));
    const fixture: RepairFixture = {
      id: `repository-${request.requestId}`,
      rootDir,
      allowlistedPaths: request.editablePaths,
      protectedPaths: readonlyPaths,
      readonlyPaths,
      testCommand: ["node", "--test", ...request.testPaths],
      maxEditFiles: request.editablePaths.length
    };
    sandbox = await createRepairSandbox(fixture);
    const baseline = await sandbox.runTests(options.signal);
    const original = new Map(request.files.map((file) => [file.path, file.content]));
    let jobId: string | undefined;
    const snapshot = (result: GovernedRepairResult | null = null): RepositoryRepairResult => ({
      requestId: request.requestId,
      status: "completed",
      model: GPT_5_4_MINI_STANDARD_RATE_CARD.model,
      rateCardVersion: GPT_5_4_MINI_STANDARD_RATE_CARD.version,
      baseline: { ...baseline, stdout: baseline.stdout.slice(0, 16 * 1024) },
      result,
      changes: sandbox!.editedPaths().map((path) => ({ path, before: original.get(path)!, after: sandbox!.readFile(path) })),
      testPaths: [...request.testPaths],
      ...(jobId ? { jobId } : {})
    });
    if (baseline.exitCode === 0) return { ...snapshot(), status: "already_passing" };
    // Setup/import/timeout failures are not a failed assertion the agent can repair.
    if (baseline.exitCode === 124 || /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_UNSUPPORTED|ERR_UNKNOWN_FILE_EXTENSION|ERR_PACKAGE_PATH_NOT_EXPORTED|SyntaxError:|Operation not permitted|EACCES|EPERM/.test(baseline.stdout) ||
      !/(?:ERR_ASSERTION|AssertionError|failureType: ['"]testCodeFailure)/.test(baseline.stdout)) {
      return { ...snapshot(), status: "baseline_failed" };
    }
    options.onCheckpoint?.(snapshot());
    const result = await runGovernedRepair({
      service: options.service,
      fixture,
      sandbox,
      jobId: `repository-${request.requestId}`,
      budgetUsd: request.budgetUsd,
      maxResponses: request.maxResponses,
      finalInputTokenLimit: 32_768,
      minimumFinalOutputTokens: 100,
      workMaxOutputTokens: 2_048,
      signal: options.signal,
      budgetStrategy: options.strategy,
      onSession(id) { jobId = id; options.onCheckpoint?.(snapshot()); },
      onTrace() { options.onCheckpoint?.(snapshot()); }
    });
    return snapshot(result);
  } finally {
    await sandbox?.dispose();
    await rm(rootDir, { recursive: true, force: true });
  }
}
