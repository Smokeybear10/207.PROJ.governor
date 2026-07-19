import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FileJobStore } from "../server/jobs/store.js";
import { parseUsdToMicroUsd } from "../server/jobs/service.js";
import { loadBenchmarkManifest, runRepairBenchmark, type BenchmarkAttempt, type BenchmarkMode } from "../server/repair/benchmark.js";

const HELP = `Usage: npm run benchmark:repair -- [options]

  --smoke                     Scripted integration check; no provider calls (default)
  --live                      Paid model comparison; requires OPENAI_API_KEY
  --budget-usd AMOUNT          Budget per task per arm (smoke default: 0.10)
  --total-budget-usd AMOUNT    Maximum allocated budget across both arms
  --manifest PATH             JSON manifest with task files and selections
  --output PATH               Save JSON report; required for live runs
  --max-responses COUNT        4–24 responses per attempt (default: 12)
  --help                      Show this help

Live runs require both budget flags and --output. The aggregate budget must
cover two attempts per task. Existing output files are never overwritten.
The default eight tasks are authored regressions, not real-world evidence.
Smoke costs are simulated. Both comparison arms retain final-answer reserves.
Live runs send selected source and tests to OpenAI; known smoke patches are
never added to the live model input.
`;

type BenchmarkCliArguments = {
  mode: BenchmarkMode;
  budgetUsd: string;
  totalBudgetUsd?: string;
  manifestPath?: string;
  outputPath?: string;
  maxResponses: number;
  help: boolean;
};

export function parseRepairBenchmarkArgs(args: readonly string[]): BenchmarkCliArguments {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (["--smoke", "--live", "--help"].includes(flag)) {
      if (switches.has(flag)) throw new Error(`Duplicate flag ${flag}.`);
      switches.add(flag);
      continue;
    }
    if (!["--budget-usd", "--total-budget-usd", "--manifest", "--output", "--max-responses"].includes(flag)) {
      throw new Error(`Unknown option ${flag}. Use --help.`);
    }
    if (values.has(flag)) throw new Error(`Duplicate flag ${flag}.`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    values.set(flag, value);
  }
  if (switches.has("--live") && switches.has("--smoke")) throw new Error("Choose either --smoke or --live.");
  const mode = switches.has("--live") ? "live" : "smoke";
  const help = switches.has("--help");
  if (!help && mode === "live" && ["--budget-usd", "--total-budget-usd", "--output"].some((flag) => !values.has(flag))) {
    throw new Error("Live runs require explicit --budget-usd, --total-budget-usd and --output before paid calls are allowed.");
  }
  const budgetUsd = values.get("--budget-usd") ?? "0.10";
  if (parseUsdToMicroUsd(budgetUsd) === 0) throw new Error("Per-attempt budget must be positive.");
  const totalBudgetUsd = values.get("--total-budget-usd");
  if (totalBudgetUsd !== undefined) parseUsdToMicroUsd(totalBudgetUsd);
  const maxResponsesText = values.get("--max-responses") ?? "12";
  if (!/^\d+$/.test(maxResponsesText)) throw new Error("max-responses must be an integer from 4 through 24.");
  const maxResponses = Number(maxResponsesText);
  if (maxResponses < 4 || maxResponses > 24) throw new Error("max-responses must be an integer from 4 through 24.");
  return {
    mode, help, budgetUsd, totalBudgetUsd, maxResponses,
    manifestPath: values.get("--manifest"), outputPath: values.get("--output")
  };
}

export async function runRepairBenchmarkCli(args: readonly string[]): Promise<number> {
  const options = parseRepairBenchmarkArgs(args);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const manifest = await loadBenchmarkManifest(options.manifestPath);
  const allocated = parseUsdToMicroUsd(options.budgetUsd) * manifest.tasks.length * 2;
  const totalBudgetUsd = options.totalBudgetUsd ?? (allocated / 1_000_000).toFixed(6);
  if (!Number.isSafeInteger(allocated) || parseUsdToMicroUsd(totalBudgetUsd) < allocated) {
    throw new Error("Aggregate budget must cover both arms of every task. No provider calls were made.");
  }
  if (options.mode === "live" && !process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("Set OPENAI_API_KEY to run a live comparison. No provider calls were made.");
  }
  const outputPath = options.outputPath ? resolve(options.outputPath) : undefined;
  if (outputPath) {
    const claim = await open(outputPath, "wx", 0o600);
    await claim.close();
  }
  let jobStore: FileJobStore | undefined;
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("Benchmark interrupted."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const attempts: BenchmarkAttempt[] = [];
  const save = async (value: unknown): Promise<void> => {
    if (!outputPath) return;
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
    const temporary = await open(temporaryPath, "wx", 0o600);
    try {
      try {
        await temporary.writeFile(text, "utf8");
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      await rename(temporaryPath, outputPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  };
  try {
    if (options.mode === "live") jobStore = await FileJobStore.open(`${resolve(options.outputPath!)}.ledger`);
    await save({ status: "running", mode: options.mode, dataset: manifest.label, allocatedCeilingsMicroUsd: allocated, attempts });
    const report = await runRepairBenchmark({
      mode: options.mode, manifest, budgetUsd: options.budgetUsd, totalBudgetUsd,
      maxResponses: options.maxResponses, signal: controller.signal, jobStore,
      async onAttempt(attempt) {
        attempts.push(attempt);
        process.stderr.write(`${attempt.taskId} / ${attempt.arm}: ${attempt.status}\n`);
        await save({ status: "running", mode: options.mode, dataset: manifest.label, allocatedCeilingsMicroUsd: allocated, attempts });
      }
    });
    await save(report);
    if (outputPath) process.stdout.write(`Report: ${outputPath}\n`);
    else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.interrupted) return 130;
    if (report.haltedReason) return 1;
    return options.mode === "smoke" && report.attempts.some((attempt) => !attempt.verified) ? 1 : 0;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    await jobStore?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runRepairBenchmarkCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Benchmark failed."}\n`);
    process.exitCode = 1;
  });
}
