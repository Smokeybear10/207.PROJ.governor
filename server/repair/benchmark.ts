import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { GPT_5_4_MINI_STANDARD_RATE_CARD } from "../governor/index.js";
import { GovernedJobService } from "../jobs/index.js";
import { parseUsdToMicroUsd } from "../jobs/service.js";
import type { JobStore } from "../jobs/store.js";
import { OpenAiResponsesClient } from "../openai/index.js";
import { ScriptedResponsesProvider, type ScriptedResponse } from "../openai/scripted-provider.js";
import type { ResponsesProvider } from "../runtime/index.js";
import { createRepairSandbox } from "./sandbox.js";
import type { RepairFixture, RepairSandbox } from "./types.js";
import { runGovernedRepair } from "./workflow.js";

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const forbiddenSegments = new Set(["node_modules", "vendor", "dist", "build", "coverage", "secrets"]);
const filePath = z.string().min(1).max(240).refine((value) =>
  /^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*\.(?:[cm]?js|[cm]?ts|json)$/.test(value) &&
  value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !forbiddenSegments.has(part.toLowerCase())),
  "Use a relative JavaScript, TypeScript or JSON path without hidden or dependency directories."
);
const taskSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  description: z.string().min(1).max(500),
  files: z.array(z.strictObject({ path: filePath, content: z.string().max(65_536) })).min(2).max(64),
  editablePaths: z.array(filePath).min(1).max(10),
  testPaths: z.array(filePath).min(1).max(10),
  smokeEdits: z.array(z.strictObject({ path: filePath, oldText: z.string().min(1), newText: z.string() })).min(1).max(10).optional()
}).superRefine((task, context) => {
  const paths = task.files.map((file) => file.path);
  const unique = new Set(paths.map((path) => path.toLowerCase()));
  const badSelection = [...task.editablePaths, ...task.testPaths].some((path) => !paths.includes(path));
  const duplicates = new Set(task.editablePaths).size !== task.editablePaths.length || new Set(task.testPaths).size !== task.testPaths.length;
  const overlapping = task.testPaths.some((path) => task.editablePaths.includes(path));
  const testsEditable = task.editablePaths.some((path) => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\./i.test(path));
  const prefixCollision = paths.some((path) => paths.some((other) => other.toLowerCase().startsWith(`${path.toLowerCase()}/`)));
  if (unique.size !== paths.length || badSelection || duplicates || overlapping || testsEditable || prefixCollision) {
    context.addIssue({ code: "custom", message: "Files must be unique; source and test selections must exist and be disjoint." });
  }
  if (task.files.some((file) => file.content.includes("\0") || Buffer.byteLength(file.content) > 65_536) ||
      task.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0) > 131_072) {
    context.addIssue({ code: "custom", message: "Use text files up to 64 KiB each and 128 KiB per task." });
  }
  for (const edit of task.smokeEdits ?? []) {
    const source = task.files.find((file) => file.path === edit.path);
    if (!task.editablePaths.includes(edit.path) || !source || source.content.indexOf(edit.oldText) < 0 ||
        source.content.indexOf(edit.oldText) !== source.content.lastIndexOf(edit.oldText)) {
      context.addIssue({ code: "custom", message: "Each smoke edit must match one occurrence in an editable source file." });
    }
  }
});
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  label: z.string().min(1).max(120),
  provenance: z.string().min(1).max(2_000),
  tasks: z.array(taskSchema).min(1).max(100)
}).refine((manifest) => new Set(manifest.tasks.map((task) => task.id)).size === manifest.tasks.length, "Task IDs must be unique.");

export type RepairBenchmarkManifest = z.infer<typeof manifestSchema>;
export type RepairBenchmarkTask = RepairBenchmarkManifest["tasks"][number];
export type BenchmarkArm = "governed" | "fixed_cap_with_reserve";
export type BenchmarkMode = "smoke" | "live";

export type BenchmarkAttempt = {
  taskId: string;
  taskHash: string;
  arm: BenchmarkArm;
  status: "repaired" | "not_repaired" | "invalid_baseline" | "error" | "not_run";
  verified: boolean;
  durationMs: number;
  baselineExitCode: number | null;
  reason: string | null;
  accountingKnown: boolean;
  settledMicroUsd: number | null;
  heldMicroUsd: number;
  committedMicroUsd: number;
  budgetMicroUsd: number;
  responsesStarted: number | null;
  unresolvedRequests: number | null;
  budgetExceeded: boolean;
  editedPaths: string[];
  jobId: string | null;
};

export type BenchmarkSummary = {
  assigned: number;
  successes: number;
  successRate: number;
  errors: number;
  invalidBaselines: number;
  notRun: number;
  accountingUnknownAttempts: number;
  totalSettledMicroUsd: number | null;
  totalHeldMicroUsd: number;
  totalCommittedMicroUsd: number;
  settledCostPerSuccessMicroUsd: number | null;
  committedCostPerSuccessMicroUsd: number | null;
  totalDurationMs: number;
  unresolvedRequests: number | null;
  budgetBreaches: number;
};

export type RepairBenchmarkReport = {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  mode: BenchmarkMode;
  evidence: "scripted_integration_only" | "live_provider_usage_not_invoice_verified";
  dataset: { label: string; provenance: string; manifestSha256: string; tasks: number };
  pricing: { model: string; rateCardVersion: string; rates: typeof GPT_5_4_MINI_STANDARD_RATE_CARD.rates };
  policy: {
    perAttemptBudgetMicroUsd: number;
    aggregateBudgetMicroUsd: number;
    allocatedCeilingsMicroUsd: number;
    maxResponses: number;
    workMaxOutputTokens: number;
    finalInputTokenLimit: number;
    comparison: string;
    order: string;
  };
  interrupted: boolean;
  haltedReason: string | null;
  caveats: string[];
  attempts: BenchmarkAttempt[];
  summaries: Record<BenchmarkArm, BenchmarkSummary>;
};

export type RepairBenchmarkOptions = {
  mode: BenchmarkMode;
  manifest: RepairBenchmarkManifest;
  budgetUsd: string;
  totalBudgetUsd: string;
  maxResponses?: number;
  signal?: AbortSignal;
  onAttempt?: (attempt: BenchmarkAttempt) => void | Promise<void>;
  providerFactory?: (task: RepairBenchmarkTask, arm: BenchmarkArm) => ResponsesProvider;
  jobStore?: JobStore;
};

export function parseBenchmarkManifest(value: unknown): RepairBenchmarkManifest {
  return manifestSchema.parse(value);
}

export async function loadBenchmarkManifest(path?: string): Promise<RepairBenchmarkManifest> {
  const file = path ?? new URL("./benchmark-fixtures/regressions.json", import.meta.url);
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error("Benchmark manifest must be a regular file up to 4 MiB.");
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_MANIFEST_BYTES) throw new Error("Benchmark manifest exceeds 4 MiB.");
    return parseBenchmarkManifest(JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown);
  } finally {
    await handle.close();
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function functionScript(callId: string, name: string, args: Record<string, unknown>, inputTokens: number): ScriptedResponse {
  return {
    inputTokens, outputTokens: 128,
    output: [{ type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args), status: "completed" }]
  };
}

export function benchmarkSmokeProvider(task: RepairBenchmarkTask): ScriptedResponsesProvider {
  if (!task.smokeEdits?.length) throw new Error(`Task ${task.id} has no known patch for scripted smoke mode.`);
  return new ScriptedResponsesProvider([
    functionScript("before", "run_tests", {}, 800),
    functionScript("patch", "apply_patch", { edits: task.smokeEdits.map((edit) => ({ path: edit.path, old_text: edit.oldText, new_text: edit.newText })) }, 1_100),
    functionScript("after", "run_tests", {}, 1_400),
    {
      inputTokens: 1_600, outputTokens: 100,
      output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Applied the known regression patch and ran the selected tests. This scripted result checks the harness, not model performance." }] }]
    }
  ]);
}

export function summarizeBenchmark(attempts: readonly BenchmarkAttempt[]): BenchmarkSummary {
  const successes = attempts.filter((attempt) => attempt.verified).length;
  const sum = (key: "heldMicroUsd" | "committedMicroUsd" | "durationMs"): number =>
    attempts.reduce((total, attempt) => total + attempt[key], 0);
  const accountingUnknownAttempts = attempts.filter((attempt) => !attempt.accountingKnown).length;
  const totalSettledMicroUsd = accountingUnknownAttempts > 0 ? null : attempts.reduce((total, attempt) => total + (attempt.settledMicroUsd ?? 0), 0);
  const totalCommittedMicroUsd = sum("committedMicroUsd");
  return {
    assigned: attempts.length,
    successes,
    successRate: attempts.length === 0 ? 0 : successes / attempts.length,
    errors: attempts.filter((attempt) => attempt.status === "error").length,
    invalidBaselines: attempts.filter((attempt) => attempt.status === "invalid_baseline").length,
    notRun: attempts.filter((attempt) => attempt.status === "not_run").length,
    accountingUnknownAttempts,
    totalSettledMicroUsd,
    totalHeldMicroUsd: sum("heldMicroUsd"),
    totalCommittedMicroUsd,
    settledCostPerSuccessMicroUsd: successes === 0 || totalSettledMicroUsd === null ? null : totalSettledMicroUsd / successes,
    committedCostPerSuccessMicroUsd: successes === 0 ? null : totalCommittedMicroUsd / successes,
    totalDurationMs: sum("durationMs"),
    unresolvedRequests: accountingUnknownAttempts > 0 ? null : attempts.reduce((total, attempt) => total + (attempt.unresolvedRequests ?? 0), 0),
    budgetBreaches: attempts.filter((attempt) => attempt.budgetExceeded).length
  };
}

function emptyAttempt(task: RepairBenchmarkTask, arm: BenchmarkArm, budgetMicroUsd: number): BenchmarkAttempt {
  return {
    taskId: task.id,
    taskHash: digest({ files: [...task.files].sort((a, b) => a.path.localeCompare(b.path)), editablePaths: [...task.editablePaths].sort(), testPaths: [...task.testPaths].sort() }),
    arm, status: "not_run", verified: false, durationMs: 0, baselineExitCode: null, reason: null,
    accountingKnown: true, settledMicroUsd: 0, heldMicroUsd: 0, committedMicroUsd: 0, budgetMicroUsd,
    responsesStarted: 0, unresolvedRequests: 0, budgetExceeded: false, editedPaths: [], jobId: null
  };
}

async function runAttempt(task: RepairBenchmarkTask, attempt: BenchmarkAttempt, options: RepairBenchmarkOptions, maxResponses: number): Promise<void> {
  const startedAt = Date.now();
  let root: string | undefined;
  let sandbox: RepairSandbox | undefined;
  let service: GovernedJobService | undefined;
  try {
    root = await mkdtemp(join(tmpdir(), "governor-benchmark-"));
    for (const file of task.files) {
      const destination = join(root, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    const protectedPaths = task.files.map((file) => file.path).filter((path) => !task.editablePaths.includes(path));
    const fixture: RepairFixture = {
      id: task.id, rootDir: root, allowlistedPaths: task.editablePaths,
      protectedPaths, readonlyPaths: protectedPaths,
      testCommand: ["node", "--test", ...task.testPaths], maxEditFiles: task.editablePaths.length
    };
    sandbox = await createRepairSandbox(fixture);
    const baseline = await sandbox.runTests(options.signal);
    attempt.baselineExitCode = baseline.exitCode;
    if (baseline.exitCode !== 1 || !/^(?:#|ℹ) fail [1-9]\d*/m.test(baseline.stdout)) {
      attempt.status = "invalid_baseline";
      attempt.reason = baseline.exitCode === 0 ? "Selected tests already pass." : "Baseline did not report a normal failing Node test run.";
      return;
    }
    const provider = options.providerFactory?.(task, attempt.arm) ?? (options.mode === "smoke"
      ? benchmarkSmokeProvider(task)
      : new OpenAiResponsesClient({ apiKey: process.env.OPENAI_API_KEY ?? "" }));
    service = new GovernedJobService({ provider, store: options.jobStore });
    const result = await runGovernedRepair({
      service, sandbox, fixture,
      jobId: `benchmark-${task.id}-${attempt.arm}`,
      budgetUsd: options.budgetUsd,
      maxResponses,
      maxWorkResponses: maxResponses - 1,
      workMaxOutputTokens: 1_024,
      finalInputTokenLimit: 32_768,
      minimumFinalOutputTokens: 100,
      budgetStrategy: attempt.arm === "governed" ? "governed" : "hard_cap",
      onSession: (jobId) => { attempt.jobId = jobId; },
      signal: options.signal
    });
    attempt.status = result.status;
    attempt.verified = result.evaluation?.passed === true && sandbox.editedPaths().length > 0;
    attempt.reason = result.status === "not_repaired" ? result.reason : null;
    attempt.editedPaths = [...sandbox.editedPaths()];
  } catch (error) {
    attempt.status = "error";
    attempt.reason = options.signal?.aborted ? "Benchmark cancelled." : error instanceof Error ? `${error.name}: ${error.message.slice(0, 500)}` : "Unknown execution error.";
  } finally {
    if (service && attempt.jobId) {
      try {
        const report = service.getReport(attempt.jobId);
        const accounting = report.job.accounting as Record<string, number>;
        attempt.settledMicroUsd = accounting.settled_micro_usd;
        attempt.heldMicroUsd = accounting.reserved_micro_usd;
        attempt.committedMicroUsd = accounting.committed_micro_usd;
        attempt.responsesStarted = accounting.responses_started;
        attempt.unresolvedRequests = report.requests.filter((request) => {
          const status = (request as Record<string, unknown>).status;
          return status === "unresolved" || status === "in_progress";
        }).length;
        attempt.budgetExceeded = attempt.committedMicroUsd > attempt.budgetMicroUsd;
      } catch {
        attempt.status = "error";
        attempt.accountingKnown = false;
        attempt.settledMicroUsd = null;
        attempt.heldMicroUsd = attempt.budgetMicroUsd;
        attempt.committedMicroUsd = attempt.budgetMicroUsd;
        attempt.responsesStarted = null;
        attempt.unresolvedRequests = null;
        attempt.reason = "Accounting unavailable. The entire attempt budget remains provisionally held; paid execution is stopped.";
      }
    }
    const cleanup = await Promise.allSettled([
      sandbox?.dispose(),
      root ? rm(root, { recursive: true, force: true }) : undefined
    ]);
    if (cleanup.some((result) => result.status === "rejected")) {
      attempt.status = "error";
      attempt.reason = `${attempt.reason ?? ""} Temporary working-copy cleanup failed.`.trim();
    }
    attempt.durationMs = Date.now() - startedAt;
  }
}

export async function runRepairBenchmark(options: RepairBenchmarkOptions): Promise<RepairBenchmarkReport> {
  const manifest = parseBenchmarkManifest(options.manifest);
  if (options.mode !== "smoke" && options.mode !== "live") throw new Error("Benchmark mode must be smoke or live.");
  const budget = parseUsdToMicroUsd(options.budgetUsd);
  const totalBudget = parseUsdToMicroUsd(options.totalBudgetUsd);
  const allocated = budget * manifest.tasks.length * 2;
  if (budget === 0 || !Number.isSafeInteger(allocated) || allocated > totalBudget) {
    throw new Error("Aggregate budget must cover both arms of every assigned task before any request is dispatched.");
  }
  const maxResponses = options.maxResponses ?? 12;
  if (!Number.isInteger(maxResponses) || maxResponses < 4 || maxResponses > 24) throw new Error("maxResponses must be between 4 and 24.");
  if (options.mode === "live" && !options.providerFactory && !process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("Live benchmarks require OPENAI_API_KEY and explicit per-attempt and aggregate budgets.");
  }
  if (options.mode === "smoke" && !options.providerFactory && manifest.tasks.some((task) => !task.smokeEdits?.length)) {
    throw new Error("Scripted smoke mode requires a known smoke patch for every task.");
  }
  const scheduled = manifest.tasks.flatMap((task, index) => {
    const arms: BenchmarkArm[] = index % 2 === 0 ? ["governed", "fixed_cap_with_reserve"] : ["fixed_cap_with_reserve", "governed"];
    return arms.map((arm) => ({ task, attempt: emptyAttempt(task, arm, budget) }));
  });
  const startedAt = new Date().toISOString();
  let haltedReason: string | null = null;
  for (const { task, attempt } of scheduled) {
    if (options.signal?.aborted) {
      attempt.reason = "Cancelled before this assigned attempt started.";
      continue;
    }
    try {
      options.jobStore?.assertAvailable();
    } catch {
      haltedReason = "The durable accounting store is unavailable. Remaining attempts were not dispatched.";
    }
    if (haltedReason) {
      attempt.reason = haltedReason;
      continue;
    }
    await runAttempt(task, attempt, options, maxResponses);
    if (!attempt.accountingKnown || attempt.budgetExceeded) {
      haltedReason = "Budget accounting needs review. Remaining attempts were not dispatched.";
    }
    await options.onAttempt?.({ ...attempt });
  }
  const attempts = scheduled.map(({ attempt }) => attempt);
  return {
    schemaVersion: 1,
    runId: randomUUID(), startedAt, finishedAt: new Date().toISOString(), mode: options.mode,
    evidence: options.mode === "smoke" ? "scripted_integration_only" : "live_provider_usage_not_invoice_verified",
    dataset: { label: manifest.label, provenance: manifest.provenance, manifestSha256: digest(manifest), tasks: manifest.tasks.length },
    pricing: { model: GPT_5_4_MINI_STANDARD_RATE_CARD.model, rateCardVersion: GPT_5_4_MINI_STANDARD_RATE_CARD.version, rates: GPT_5_4_MINI_STANDARD_RATE_CARD.rates },
    policy: {
      perAttemptBudgetMicroUsd: budget, aggregateBudgetMicroUsd: totalBudget, allocatedCeilingsMicroUsd: allocated,
      maxResponses, workMaxOutputTokens: 1_024, finalInputTokenLimit: 32_768,
      comparison: "Both arms use the same agent, model, repair tools, exact preflight, conservative reservations, final-answer reserve and task budget. Governed exposes budget tools and can shrink work output caps; fixed_cap_with_reserve hides budget tools and denies work unless the full output cap fits. This is a policy ablation, not an ungoverned-agent comparison.",
      order: "Sequential paired tasks, alternating which arm runs first. One trial per arm per task; no significance claim."
    },
    interrupted: options.signal?.aborted ?? false,
    haltedReason,
    caveats: [
      options.mode === "smoke" ? "Known patches and synthetic token counts exercise integration only; simulated ledger amounts are not paid spending or evidence of model savings." : "Cost is calculated from provider-reported tokens and the pinned rate card; it has not been reconciled to a provider invoice.",
      "Dataset provenance is supplied by its author. Authored examples are not held-out real-world bugs.",
      "Success means the selected unchanged tests passed in a fresh isolated copy with a source change. Shared-process tests are not tamper-proof and do not establish correctness beyond those tests.",
      "All assigned attempts, including invalid baselines, errors and cancelled attempts, remain in the success-rate denominator. Costs include failed attempts; held reservations are reported separately.",
      "If accounting is unavailable, settled cost is null and the full attempt budget is provisionally held. Totals with unknown accounting are conservative bounds, not measured spending."
    ],
    attempts,
    summaries: {
      governed: summarizeBenchmark(attempts.filter((attempt) => attempt.arm === "governed")),
      fixed_cap_with_reserve: summarizeBenchmark(attempts.filter((attempt) => attempt.arm === "fixed_cap_with_reserve"))
    }
  };
}
