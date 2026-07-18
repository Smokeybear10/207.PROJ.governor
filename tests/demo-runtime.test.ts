import { describe, expect, it } from "vitest";
import {
  DEMO_CONTROLLERS,
  DEMO_MODE,
  DEMO_RATE_CARD_VERSION,
  DEMO_TRUTH_LABEL,
  DemoInputError,
  createDemoRun,
  getDemoCatalog,
  type RunTrace,
  type SyntheticCostReceipt
} from "../server/demo/index.js";

function allRuns(): RunTrace[] {
  return getDemoCatalog().scenarios.flatMap((scenario) =>
    DEMO_CONTROLLERS.map((controller) =>
      createDemoRun({ scenarioId: scenario.id, controller })
    )
  );
}

function ceilPrice(tokens: number, rate: number): number {
  const numerator = BigInt(tokens) * BigInt(rate);
  return Number((numerator + 999_999n) / 1_000_000n);
}

function expectedReceiptTotal(receipt: SyntheticCostReceipt): number {
  return (
    ceilPrice(receipt.usage.uncachedInputTokens, 750_000) +
    ceilPrice(receipt.usage.cachedInputTokens, 75_000) +
    ceilPrice(receipt.usage.outputTokens, 4_500_000)
  );
}

describe("deterministic demo catalog", () => {
  it("exposes three realistic PR scenarios and a labeled benchmark", () => {
    const catalog = getDemoCatalog();

    expect(catalog.scenarios.map((scenario) => scenario.id)).toEqual([
      "large-failing-log",
      "clean-small-diff",
      "repeated-unchanged-retry"
    ]);
    expect(catalog.scenarios).toHaveLength(3);
    expect(catalog.scenarios.filter((scenario) => scenario.spotlight)).toHaveLength(
      1
    );
    expect(catalog.benchmark).toMatchObject({
      mode: DEMO_MODE,
      truthLabel: DEMO_TRUTH_LABEL,
      scenarioCount: 3,
      controllers: DEMO_CONTROLLERS,
      conclusion: "SHADOW_INCREMENTAL_VALUE_NOT_ESTABLISHED",
      provenance: {
        origin: "SYNTHETIC_DETERMINISTIC_FIXTURE",
        externalApiCalls: 0,
        usageSource: "SIMULATED"
      }
    });
    expect(catalog.benchmark.rateCard).toMatchObject({
      version: DEMO_RATE_CARD_VERSION,
      model: "gpt-5.4-mini",
      serviceTier: "standard",
      uncachedInputUsdPerMillionTokens: 0.75,
      cachedInputUsdPerMillionTokens: 0.075,
      outputUsdPerMillionTokens: 4.5,
      rounding: "CEIL_EACH_AGGREGATE_CHARGE"
    });
  });

  it("returns fresh deterministic values", () => {
    const firstCatalog = getDemoCatalog();
    const firstRun = createDemoRun({
      scenarioId: "large-failing-log",
      controller: "shadow"
    });

    expect(getDemoCatalog()).toEqual(firstCatalog);
    expect(
      createDemoRun({
        scenarioId: "large-failing-log",
        controller: "shadow"
      })
    ).toEqual(firstRun);

    const mutableCatalog = firstCatalog as {
      scenarios: Array<{ title: string }>;
    };
    mutableCatalog.scenarios[0]!.title = "mutated by caller";
    expect(getDemoCatalog().scenarios[0]!.title).toBe(
      "Large failing test log"
    );
  });
});

describe("demo trace invariants", () => {
  it("builds complete, stable traces for every scenario/controller pair", () => {
    const ids = new Set<string>();

    for (const run of allRuns()) {
      expect(run.version).toBe(1);
      expect(run.mode).toBe("DEMO");
      expect(run.truthLabel).toBe(DEMO_TRUTH_LABEL);
      expect(run.provenance.externalApiCalls).toBe(0);
      expect(run.provenance.usageSource).toBe("SIMULATED");
      expect(run.rateCard.version).toBe(DEMO_RATE_CARD_VERSION);
      expect(run.taskPolicy.rateCardVersion).toBe(DEMO_RATE_CARD_VERSION);
      expect(run.scenario.id).toBe(run.scenarioId);
      expect(run.id).toBe(
        `demo-run:${run.scenarioId}:${run.controller}:v1`
      );
      expect(run.events.length).toBeGreaterThan(0);
      expect(run.finalSummary.status).toBe(run.status);
      expect(ids.has(run.id)).toBe(false);
      ids.add(run.id);
    }

    expect(ids.size).toBe(9);
  });

  it("keeps event sequence, timing, and cumulative usage monotonic", () => {
    for (const run of allRuns()) {
      let priorOffset = -1;
      let priorSettled = 0;
      let priorInput = 0;
      let priorOutput = 0;

      run.events.forEach((event, index) => {
        expect(event.sequence).toBe(index + 1);
        expect(event.offsetMs).toBeGreaterThan(priorOffset);
        expect(event.metrics.settledMicroUsd).toBeGreaterThanOrEqual(
          priorSettled
        );
        expect(event.metrics.inputTokens).toBeGreaterThanOrEqual(priorInput);
        expect(event.metrics.outputTokens).toBeGreaterThanOrEqual(
          priorOutput
        );
        expect(event.risk.observedDrivers.length).toBeGreaterThan(0);

        priorOffset = event.offsetMs;
        priorSettled = event.metrics.settledMicroUsd;
        priorInput = event.metrics.inputTokens;
        priorOutput = event.metrics.outputTokens;
      });
    }
  });

  it("keeps every integer accounting snapshot inside its ceiling", () => {
    for (const run of allRuns()) {
      for (const event of run.events) {
        const { metrics } = event;
        for (const value of Object.values(metrics)) {
          expect(Number.isSafeInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }

        const committed =
          metrics.settledMicroUsd +
          metrics.reservedMicroUsd +
          metrics.finalReserveMicroUsd;
        expect(committed).toBeLessThanOrEqual(
          run.taskPolicy.applicationCeilingMicroUsd
        );
        expect(metrics.remainingMicroUsd).toBe(
          run.taskPolicy.applicationCeilingMicroUsd - committed
        );
        expect(metrics.inputTokens).toBe(
          metrics.uncachedInputTokens + metrics.cachedInputTokens
        );
      }

      const finalEvent = run.events.at(-1)!;
      expect(finalEvent.metrics.settledMicroUsd).toBe(
        run.finalSummary.settledMicroUsd
      );
      expect(run.finalSummary.unusedMicroUsd).toBe(
        run.taskPolicy.applicationCeilingMicroUsd -
          run.finalSummary.settledMicroUsd
      );
    }
  });

  it("reprices every synthetic receipt exactly under the pinned rate card", () => {
    for (const run of allRuns()) {
      let cumulativeSettled = 0;
      const eventReceipts: SyntheticCostReceipt[] = [];

      for (const event of run.events) {
        if (event.syntheticReceipt) {
          const receipt = event.syntheticReceipt;
          eventReceipts.push(receipt);
          expect(receipt.kind).toBe("SYNTHETIC_COST_RECEIPT");
          expect(receipt.rateCardVersion).toBe(DEMO_RATE_CARD_VERSION);
          expect(receipt.disclosure).toContain("not measured API usage");
          expect(receipt.totalMicroUsd).toBe(
            expectedReceiptTotal(receipt)
          );
          expect(
            Object.values(receipt.charges).reduce(
              (total, charge) => total + charge,
              0
            )
          ).toBe(receipt.totalMicroUsd);
          cumulativeSettled += receipt.totalMicroUsd;
        }
        expect(event.metrics.settledMicroUsd).toBe(cumulativeSettled);
      }

      expect(run.syntheticReceipts).toEqual(eventReceipts);
      expect(cumulativeSettled).toBe(run.finalSummary.settledMicroUsd);
    }
  });
});

describe("controller behavior and quality gating", () => {
  it("keeps static and shadow execution identical per scenario", () => {
    for (const scenario of getDemoCatalog().scenarios) {
      const staticRun = createDemoRun({
        scenarioId: scenario.id,
        controller: "static"
      });
      const shadowRun = createDemoRun({
        scenarioId: scenario.id,
        controller: "shadow"
      });
      const receiptContents = (run: RunTrace) =>
        run.syntheticReceipts.map(({ id: _id, ...receipt }) => receipt);
      const appliedDeterministicActions = (run: RunTrace) =>
        run.events.flatMap((event) => {
          const action = event.action;
          if (
            !action ||
            action.execution !== "APPLIED" ||
            action.source === "SHADOW_FORECAST"
          ) {
            return [];
          }
          const { id: _id, ...actionContents } = action;
          return [actionContents];
        });

      expect(receiptContents(shadowRun)).toEqual(receiptContents(staticRun));
      expect(shadowRun.status).toBe(staticRun.status);
      expect(shadowRun.finalSummary.status).toBe(
        staticRun.finalSummary.status
      );
      expect(shadowRun.quality).toEqual(staticRun.quality);
      expect(shadowRun.events.at(-1)!.metrics).toEqual(
        staticRun.events.at(-1)!.metrics
      );
      expect(appliedDeterministicActions(shadowRun)).toEqual(
        appliedDeterministicActions(staticRun)
      );
      expect(
        shadowRun.events
          .flatMap((event) => (event.action ? [event.action] : []))
          .filter((action) => action.source === "SHADOW_FORECAST")
          .every((action) => action.execution === "RECOMMENDED")
      ).toBe(true);
    }
  });

  it("shows the flagship shadow progression and deterministic controls", () => {
    const run = createDemoRun({
      scenarioId: "large-failing-log",
      controller: "shadow"
    });
    const bands = run.events.map((event) => event.risk.band);
    const safeIndex = bands.indexOf("SAFE");
    const watchIndex = bands.indexOf("WATCH");
    const atRiskIndex = bands.indexOf("AT_RISK");

    expect(safeIndex).toBeGreaterThanOrEqual(0);
    expect(watchIndex).toBeGreaterThan(safeIndex);
    expect(atRiskIndex).toBeGreaterThan(watchIndex);
    expect(run.status).toBe("COMPLETED");
    expect(run.quality.gate).toBe("PASSED");
    expect(run.finalSummary.completedWithinPolicy).toBe(true);
    expect(run.finalSummary.appliedInterventions).toEqual([
      "REDUCE_TEST_LOG",
      "REJECT_UNCHANGED_RETRY"
    ]);

    const reduction = run.events.find(
      (event) => event.action?.kind === "REDUCE_TEST_LOG"
    )!.action!;
    expect(reduction.execution).toBe("APPLIED");
    expect(reduction.source).toBe("STATIC_GUARDRAIL");
    expect(reduction.effect.artifact).toMatchObject({
      kind: "REDUCED_TEST_LOG",
      originalTokens: 14_600,
      retainedTokens: 1_960
    });
    expect(reduction.effect.artifact!.checksumSha256).toMatch(
      /^[a-f0-9]{64}$/
    );

    const shadowRecommendation = run.events.find(
      (event) => event.action?.source === "SHADOW_FORECAST"
    )!.action!;
    expect(shadowRecommendation).toMatchObject({
      kind: "PRESERVE_COMPLETION_BUDGET",
      execution: "RECOMMENDED"
    });
  });

  it("differentiates controller behavior without pretending shadow acted", () => {
    const input = { scenarioId: "large-failing-log" } as const;
    const hardCap = createDemoRun({ ...input, controller: "hard_cap" });
    const staticRun = createDemoRun({ ...input, controller: "static" });
    const shadow = createDemoRun({ ...input, controller: "shadow" });

    expect(hardCap.status).toBe("POLICY_STOPPED");
    expect(hardCap.quality.gate).toBe("FAILED");
    expect(
      hardCap.events.some(
        (event) => event.action?.kind === "REDUCE_TEST_LOG"
      )
    ).toBe(false);
    expect(staticRun.status).toBe("COMPLETED");
    expect(
      staticRun.events.some(
        (event) => event.action?.source === "SHADOW_FORECAST"
      )
    ).toBe(false);
    expect(
      shadow.events.some(
        (event) =>
          event.action?.source === "SHADOW_FORECAST" &&
          event.action.execution === "RECOMMENDED"
      )
    ).toBe(true);
    expect(shadow.finalSummary.settledMicroUsd).toBe(
      staticRun.finalSummary.settledMicroUsd
    );
  });

  it("rejects unchanged repeated work and preserves a quality-gated finish", () => {
    const run = createDemoRun({
      scenarioId: "repeated-unchanged-retry",
      controller: "static"
    });
    const actions = run.events.flatMap((event) =>
      event.action ? [event.action] : []
    );

    expect(actions.map((action) => action.kind)).toEqual(
      expect.arrayContaining([
        "SUPPRESS_DUPLICATE_OUTPUT",
        "REJECT_UNCHANGED_RETRY"
      ])
    );
    expect(run.status).toBe("COMPLETED");
    expect(run.quality.gate).toBe("PASSED");
    expect(run.finalSummary.completedWithinPolicy).toBe(true);
  });

  it("marks failed-quality rows ineligible before exposing cost deltas", () => {
    for (const run of allRuns()) {
      expect(run.comparisonRows).toHaveLength(3);
      expect(
        run.comparisonRows.filter((row) => row.selected)
      ).toEqual([
        expect.objectContaining({ controller: run.controller })
      ]);

      for (const row of run.comparisonRows) {
        expect(row.withinCeiling).toBe(true);
        if (row.qualityGate === "FAILED") {
          expect(row.eligibleForCostComparison).toBe(false);
          expect(row.costDeltaVsStaticMicroUsd).toBeNull();
        } else {
          expect(row.eligibleForCostComparison).toBe(true);
          expect(row.costDeltaVsStaticMicroUsd).not.toBeNull();
        }
      }
    }

    const benchmark = getDemoCatalog().benchmark;
    const hardCap = benchmark.comparisonRows.find(
      (row) => row.controller === "hard_cap"
    )!;
    const staticRow = benchmark.comparisonRows.find(
      (row) => row.controller === "static"
    )!;
    const shadow = benchmark.comparisonRows.find(
      (row) => row.controller === "shadow"
    )!;

    expect(hardCap.eligibleForCostComparison).toBe(false);
    expect(hardCap.costDeltaVsStaticMicroUsd).toBeNull();
    expect(staticRow).toMatchObject({
      qualityGatePassed: true,
      costDeltaVsStaticMicroUsd: 0
    });
    expect(shadow).toMatchObject({
      qualityGatePassed: true,
      costDeltaVsStaticMicroUsd: 0
    });
    expect(shadow.totalSettledMicroUsd).toBe(
      staticRow.totalSettledMicroUsd
    );
  });
});

describe("demo input validation", () => {
  const unsafeCreate = createDemoRun as (input: unknown) => RunTrace;

  function expectCode(input: unknown, code: string): void {
    try {
      unsafeCreate(input);
      throw new Error("Expected createDemoRun to reject the input.");
    } catch (error) {
      expect(error).toBeInstanceOf(DemoInputError);
      expect((error as DemoInputError).code).toBe(code);
    }
  }

  it("rejects unknown scenarios and controllers", () => {
    expectCode(
      { scenarioId: "not-a-scenario", controller: "shadow" },
      "UNKNOWN_SCENARIO"
    );
    expectCode(
      { scenarioId: "clean-small-diff", controller: "automatic" },
      "UNKNOWN_CONTROLLER"
    );
  });

  it("rejects malformed or non-strict input objects", () => {
    expectCode(null, "INVALID_DEMO_INPUT");
    expectCode([], "INVALID_DEMO_INPUT");
    expectCode(
      { scenarioId: "clean-small-diff" },
      "INVALID_DEMO_INPUT"
    );
    expectCode(
      {
        scenarioId: "clean-small-diff",
        controller: "static",
        unexpected: true
      },
      "INVALID_DEMO_INPUT"
    );
  });
});
