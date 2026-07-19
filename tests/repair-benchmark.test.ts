import { describe, expect, it, vi } from "vitest";
import { parseRepairBenchmarkArgs } from "../cli/repair-benchmark.js";
import {
  benchmarkSmokeProvider,
  loadBenchmarkManifest,
  parseBenchmarkManifest,
  runRepairBenchmark,
  summarizeBenchmark,
  type BenchmarkAttempt,
  type RepairBenchmarkManifest
} from "../server/repair/benchmark.js";

async function oneTask(): Promise<RepairBenchmarkManifest> {
  const manifest = await loadBenchmarkManifest();
  return { ...manifest, tasks: [manifest.tasks[0]!] };
}

function row(overrides: Partial<BenchmarkAttempt> = {}): BenchmarkAttempt {
  return {
    taskId: "task", taskHash: "hash", arm: "governed", status: "not_repaired", verified: false,
    durationMs: 10, baselineExitCode: 1, reason: null, accountingKnown: true, settledMicroUsd: 100,
    heldMicroUsd: 0, committedMicroUsd: 100, budgetMicroUsd: 1_000,
    responsesStarted: 1, unresolvedRequests: 0, budgetExceeded: false, editedPaths: [], jobId: "job",
    ...overrides
  };
}

describe("repair benchmark accounting", () => {
  it("includes failed spending and assigned errors in success and cost metrics", () => {
    const summary = summarizeBenchmark([
      row({ status: "repaired", verified: true }),
      row({ status: "error", settledMicroUsd: 50, heldMicroUsd: 200, committedMicroUsd: 250, unresolvedRequests: 1 }),
      row({ status: "not_run", settledMicroUsd: 0, committedMicroUsd: 0, responsesStarted: 0 })
    ]);
    expect(summary.assigned).toBe(3);
    expect(summary.successRate).toBeCloseTo(1 / 3);
    expect(summary.totalSettledMicroUsd).toBe(150);
    expect(summary.totalHeldMicroUsd).toBe(200);
    expect(summary.totalCommittedMicroUsd).toBe(350);
    expect(summary.settledCostPerSuccessMicroUsd).toBe(150);
    expect(summary.committedCostPerSuccessMicroUsd).toBe(350);
    expect(summary.unresolvedRequests).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.notRun).toBe(1);
  });

  it("returns no cost-per-success when nothing succeeds", () => {
    expect(summarizeBenchmark([row()]).settledCostPerSuccessMicroUsd).toBeNull();
    expect(summarizeBenchmark([]).successRate).toBe(0);
    expect(summarizeBenchmark([row({ budgetExceeded: true })]).budgetBreaches).toBe(1);
  });

  it("rejects insufficient total authorization before any provider is created", async () => {
    const providerFactory = vi.fn();
    await expect(runRepairBenchmark({
      mode: "smoke", manifest: await oneTask(), budgetUsd: "0.10", totalBudgetUsd: "0.19", providerFactory
    })).rejects.toThrow("Aggregate budget");
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it("keeps all unstarted attempts in a cancelled comparison", async () => {
    const controller = new AbortController();
    controller.abort();
    const providerFactory = vi.fn();
    const report = await runRepairBenchmark({
      mode: "smoke", manifest: await oneTask(), budgetUsd: "0.10", totalBudgetUsd: "0.20", signal: controller.signal, providerFactory
    });
    expect(report.interrupted).toBe(true);
    expect(report.attempts).toHaveLength(2);
    expect(report.summaries.governed).toMatchObject({ assigned: 1, successes: 0, notRun: 1 });
    expect(providerFactory).not.toHaveBeenCalled();
  });
});

describe("repair benchmark manifest", () => {
  it("identifies authored regression examples without held-out claims", async () => {
    const manifest = await loadBenchmarkManifest();
    expect(manifest.tasks).toHaveLength(8);
    expect(manifest.provenance).toContain("not held-out real-world");
    expect(new Set(manifest.tasks.map((task) => task.id)).size).toBe(8);
  });

  it.each(["../escape.mjs", "/tmp/escape.mjs", "src/../../escape.mjs", "src/.env.json", "node_modules/secret.mjs"])("rejects escaping or sensitive path %s", async (path) => {
    const manifest = await oneTask();
    manifest.tasks[0]!.files[0]!.path = path;
    expect(() => parseBenchmarkManifest(manifest)).toThrow();
  });

  it("rejects test editing, colliding paths, and oversized UTF-8 content", async () => {
    const manifest = await oneTask();
    const editableTest = structuredClone(manifest);
    editableTest.tasks[0]!.editablePaths.push(editableTest.tasks[0]!.testPaths[0]!);
    expect(() => parseBenchmarkManifest(editableTest)).toThrow();
    const duplicate = structuredClone(manifest);
    duplicate.tasks[0]!.files.push({ ...duplicate.tasks[0]!.files[0]!, path: "SRC/MAIN.MJS" });
    expect(() => parseBenchmarkManifest(duplicate)).toThrow();
    const huge = structuredClone(manifest);
    huge.tasks[0]!.files[0]!.content = "💡".repeat(20_000);
    expect(() => parseBenchmarkManifest(huge)).toThrow();
  });
});

describe("repair benchmark command", () => {
  it("defaults to a no-network scripted check", () => {
    expect(parseRepairBenchmarkArgs([])).toMatchObject({ mode: "smoke", budgetUsd: "0.10", maxResponses: 12 });
  });

  it.each([
    ["--live"],
    ["--live", "--budget-usd", "0.10"],
    ["--live", "--budget-usd", "0.10", "--total-budget-usd", "1.60"],
    ["--smoke", "--live"],
    ["--max-responses", "5.5"],
    ["--budget-usd", "0"],
    ["--budget-usd", "0.1", "--budget-usd", "1"]
  ])("rejects incomplete or ambiguous arguments %j", (...args) => {
    expect(() => parseRepairBenchmarkArgs(args)).toThrow();
  });

  it("requires explicit per-attempt and aggregate limits plus a durable report for live runs", () => {
    expect(parseRepairBenchmarkArgs(["--live", "--budget-usd", "0.1", "--total-budget-usd", "1.6", "--output", "/tmp/benchmark.json"]))
      .toMatchObject({ mode: "live", budgetUsd: "0.1", totalBudgetUsd: "1.6", outputPath: "/tmp/benchmark.json" });
  });
});

describe.skipIf(process.platform !== "darwin")("isolated repair comparison", () => {
  it("checks all eight broken baselines and gold patches in both arms without network calls", async () => {
    const providers: ReturnType<typeof benchmarkSmokeProvider>[] = [];
    const report = await runRepairBenchmark({
      mode: "smoke", manifest: await loadBenchmarkManifest(), budgetUsd: "0.10", totalBudgetUsd: "1.60",
      providerFactory(task) {
        const provider = benchmarkSmokeProvider(task);
        providers.push(provider);
        return provider;
      }
    });
    expect(report.evidence).toBe("scripted_integration_only");
    expect(report.dataset.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.attempts).toHaveLength(16);
    expect(report.summaries.governed).toMatchObject({ assigned: 8, successes: 8, successRate: 1, errors: 0, budgetBreaches: 0 });
    expect(report.summaries.fixed_cap_with_reserve).toMatchObject({ assigned: 8, successes: 8, successRate: 1, errors: 0, budgetBreaches: 0 });
    expect(report.attempts.every((attempt) => attempt.baselineExitCode === 1 && attempt.responsesStarted === 4)).toBe(true);
    expect(report.attempts.slice(0, 4).map((attempt) => attempt.arm)).toEqual(["governed", "fixed_cap_with_reserve", "fixed_cap_with_reserve", "governed"]);
    for (const provider of providers) provider.assertComplete();
    const governedNames = providers[0]!.contexts[0]!.tools?.map((tool) => tool.name);
    const baselineNames = providers[1]!.contexts[0]!.tools?.map((tool) => tool.name);
    expect(governedNames).toContain("budget_status");
    expect(baselineNames).not.toContain("budget_status");
    expect(report.policy.comparison).toContain("not an ungoverned-agent comparison");
  }, 120_000);

  it("does not pay for a passing baseline", async () => {
    const manifest = await oneTask();
    const task = manifest.tasks[0]!;
    const edit = task.smokeEdits![0]!;
    task.files[0]!.content = task.files[0]!.content.replace(edit.oldText, edit.newText);
    delete task.smokeEdits;
    const providerFactory = vi.fn();
    const report = await runRepairBenchmark({ mode: "live", manifest, budgetUsd: "0.10", totalBudgetUsd: "0.20", providerFactory });
    expect(report.attempts.every((attempt) => attempt.status === "invalid_baseline" && attempt.settledMicroUsd === 0)).toBe(true);
    expect(providerFactory).not.toHaveBeenCalled();
  }, 30_000);

  it("retains reserved spending when provider outcome is unknown", async () => {
    const report = await runRepairBenchmark({
      mode: "smoke", manifest: await oneTask(), budgetUsd: "0.10", totalBudgetUsd: "0.20",
      providerFactory: () => ({ countInput: async () => 500, createResponse: async () => { throw new Error("connection lost after dispatch"); } })
    });
    for (const attempt of report.attempts) {
      expect(attempt.status).toBe("not_repaired");
      expect(attempt.settledMicroUsd).toBe(0);
      expect(attempt.heldMicroUsd).toBeGreaterThan(0);
      expect(attempt.unresolvedRequests).toBe(1);
      expect(attempt.budgetExceeded).toBe(false);
    }
    expect(report.summaries.governed.totalCommittedMicroUsd).toBeGreaterThan(0);
    expect(report.summaries.governed.settledCostPerSuccessMicroUsd).toBeNull();
  }, 30_000);

  it("records execution errors without dropping assigned tasks", async () => {
    const report = await runRepairBenchmark({
      mode: "smoke", manifest: await oneTask(), budgetUsd: "0.10", totalBudgetUsd: "0.20",
      providerFactory: () => { throw new Error("provider initialization failed"); }
    });
    expect(report.summaries.governed).toMatchObject({ assigned: 1, successes: 0, errors: 1, successRate: 0 });
    expect(report.summaries.fixed_cap_with_reserve).toMatchObject({ assigned: 1, successes: 0, errors: 1, successRate: 0 });
  }, 30_000);

  it("holds the entire budget and stops subsequent work if the accounting store fails after dispatch", async () => {
    let available = true;
    const providerFactory = vi.fn(() => ({
      countInput: async () => 500,
      createResponse: async () => {
        available = false;
        throw new Error("provider outcome unknown and durable store unavailable");
      }
    }));
    const report = await runRepairBenchmark({
      mode: "smoke", manifest: await oneTask(), budgetUsd: "0.10", totalBudgetUsd: "0.20", providerFactory,
      jobStore: {
        load: () => [],
        save: () => undefined,
        assertAvailable() { if (!available) throw new Error("writer unavailable"); }
      }
    });
    expect(providerFactory).toHaveBeenCalledTimes(1);
    expect(report.haltedReason).not.toBeNull();
    expect(report.attempts[0]).toMatchObject({
      status: "error", accountingKnown: false, settledMicroUsd: null, heldMicroUsd: 100_000,
      committedMicroUsd: 100_000, responsesStarted: null, unresolvedRequests: null
    });
    expect(report.attempts[1]).toMatchObject({ status: "not_run", settledMicroUsd: 0, responsesStarted: 0 });
    expect(report.summaries.governed).toMatchObject({
      assigned: 1, errors: 1, accountingUnknownAttempts: 1, totalSettledMicroUsd: null,
      totalCommittedMicroUsd: 100_000, settledCostPerSuccessMicroUsd: null
    });
  }, 30_000);
});
