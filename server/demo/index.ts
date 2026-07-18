import {
  DEMO_PROVENANCE,
  DEMO_RATE_CARD,
  DEMO_SCENARIOS,
  getRunBlueprint,
  type EventSeed,
  type RunBlueprint,
  type UsageSeed
} from "./fixtures.js";
import {
  DEMO_CONTROLLERS,
  DEMO_MODE,
  DEMO_RATE_CARD_VERSION,
  DEMO_SCENARIO_IDS,
  DEMO_TRUTH_LABEL,
  DemoInputError,
  type BenchmarkComparisonRow,
  type ControllerComparisonRow,
  type CreateDemoRunInput,
  type DemoBenchmark,
  type DemoCatalog,
  type DemoController,
  type DemoScenario,
  type DemoScenarioId,
  type EventMetricsSnapshot,
  type InterventionActionKind,
  type RunEvent,
  type RunFinalSummary,
  type RunTrace,
  type SyntheticCostReceipt
} from "./types.js";

export * from "./types.js";

const TOKENS_PER_RATE_UNIT = 1_000_000n;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function ceilPrice(tokens: number, microUsdPerMillionTokens: number): number {
  const numerator =
    BigInt(tokens) * BigInt(microUsdPerMillionTokens);
  const value =
    numerator === 0n
      ? 0n
      : (numerator + TOKENS_PER_RATE_UNIT - 1n) /
        TOKENS_PER_RATE_UNIT;

  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Synthetic demo charge exceeds the safe integer range.");
  }
  return Number(value);
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function createSyntheticReceipt(
  runId: string,
  requestNumber: number,
  usage: UsageSeed
): SyntheticCostReceipt {
  requireNonNegativeInteger(
    usage.uncachedInputTokens,
    "uncachedInputTokens"
  );
  requireNonNegativeInteger(usage.cachedInputTokens, "cachedInputTokens");
  requireNonNegativeInteger(usage.outputTokens, "outputTokens");

  const uncachedInputMicroUsd = ceilPrice(
    usage.uncachedInputTokens,
    DEMO_RATE_CARD.uncachedInputMicroUsdPerMillionTokens
  );
  const cachedInputMicroUsd = ceilPrice(
    usage.cachedInputTokens,
    DEMO_RATE_CARD.cachedInputMicroUsdPerMillionTokens
  );
  const outputMicroUsd = ceilPrice(
    usage.outputTokens,
    DEMO_RATE_CARD.outputMicroUsdPerMillionTokens
  );

  return {
    id: `${runId}:receipt:${String(requestNumber).padStart(2, "0")}`,
    kind: "SYNTHETIC_COST_RECEIPT",
    requestNumber,
    rateCardVersion: DEMO_RATE_CARD_VERSION,
    rounding: "CEIL_EACH_AGGREGATE_CHARGE",
    usage: { ...usage },
    charges: {
      uncachedInputMicroUsd,
      cachedInputMicroUsd,
      outputMicroUsd
    },
    totalMicroUsd:
      uncachedInputMicroUsd + cachedInputMicroUsd + outputMicroUsd,
    disclosure: "Synthetic demo calculation; not measured API usage."
  };
}

function createMetrics(
  scenario: DemoScenario,
  seed: EventSeed["metrics"]
): EventMetricsSnapshot {
  const numericEntries = Object.entries(seed) as Array<
    [keyof typeof seed, number]
  >;
  for (const [key, value] of numericEntries) {
    requireNonNegativeInteger(value, String(key));
  }

  const committed =
    seed.settledMicroUsd +
    seed.reservedMicroUsd +
    seed.finalReserveMicroUsd;
  const remainingMicroUsd =
    scenario.taskPolicy.applicationCeilingMicroUsd - committed;
  if (remainingMicroUsd < 0) {
    throw new Error(
      `Demo fixture ${scenario.id} exceeds its application ceiling.`
    );
  }

  return {
    settledMicroUsd: seed.settledMicroUsd,
    reservedMicroUsd: seed.reservedMicroUsd,
    finalReserveMicroUsd: seed.finalReserveMicroUsd,
    remainingMicroUsd,
    inputTokens:
      seed.uncachedInputTokens + seed.cachedInputTokens,
    uncachedInputTokens: seed.uncachedInputTokens,
    cachedInputTokens: seed.cachedInputTokens,
    outputTokens: seed.outputTokens,
    contextTokens: seed.contextTokens
  };
}

interface BuiltEvents {
  readonly events: readonly RunEvent[];
  readonly receipts: readonly SyntheticCostReceipt[];
}

function buildEvents(
  runId: string,
  scenario: DemoScenario,
  blueprint: RunBlueprint
): BuiltEvents {
  let receiptNumber = 0;
  let settledFromReceipts = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let previousOffset = -1;
  const receipts: SyntheticCostReceipt[] = [];

  const events = blueprint.events.map((seed, index): RunEvent => {
    if (!Number.isSafeInteger(seed.offsetMs) || seed.offsetMs <= previousOffset) {
      throw new Error(
        `Demo fixture ${scenario.id} has non-monotonic event timing.`
      );
    }
    previousOffset = seed.offsetMs;

    const sequence = index + 1;
    const eventId = `${runId}:event:${String(sequence).padStart(2, "0")}`;
    const metrics = createMetrics(scenario, seed.metrics);
    let syntheticReceipt: SyntheticCostReceipt | undefined;

    if (seed.receiptUsage) {
      receiptNumber += 1;
      syntheticReceipt = createSyntheticReceipt(
        runId,
        receiptNumber,
        seed.receiptUsage
      );
      receipts.push(syntheticReceipt);
      settledFromReceipts += syntheticReceipt.totalMicroUsd;
      uncachedInputTokens +=
        syntheticReceipt.usage.uncachedInputTokens;
      cachedInputTokens += syntheticReceipt.usage.cachedInputTokens;
      outputTokens += syntheticReceipt.usage.outputTokens;
    }

    if (
      metrics.settledMicroUsd !== settledFromReceipts ||
      metrics.uncachedInputTokens !== uncachedInputTokens ||
      metrics.cachedInputTokens !== cachedInputTokens ||
      metrics.outputTokens !== outputTokens
    ) {
      throw new Error(
        `Demo fixture ${scenario.id} has a receipt/accounting mismatch at event ${sequence}.`
      );
    }

    return {
      id: eventId,
      sequence,
      offsetMs: seed.offsetMs,
      type: seed.type,
      title: seed.title,
      detail: seed.detail,
      metrics,
      risk: clone(seed.risk),
      ...(seed.action
        ? {
            action: {
              ...clone(seed.action),
              id: `${eventId}:action`
            }
          }
        : {}),
      ...(syntheticReceipt ? { syntheticReceipt } : {})
    };
  });

  const terminalEvent = events.at(-1);
  const expectedTerminalType =
    blueprint.status === "COMPLETED" ? "RUN_COMPLETED" : "RUN_STOPPED";
  if (!terminalEvent || terminalEvent.type !== expectedTerminalType) {
    throw new Error(
      `Demo fixture ${scenario.id} does not end in ${expectedTerminalType}.`
    );
  }

  return { events, receipts };
}

function finalSettledMicroUsd(blueprint: RunBlueprint): number {
  const finalEvent = blueprint.events.at(-1);
  if (!finalEvent) {
    throw new Error("Demo run blueprints must contain at least one event.");
  }
  return finalEvent.metrics.settledMicroUsd;
}

function appliedInterventionKinds(
  blueprint: RunBlueprint
): readonly InterventionActionKind[] {
  return blueprint.events.flatMap((event) =>
    event.action?.execution === "APPLIED" ? [event.action.kind] : []
  );
}

function validateQuality(blueprint: RunBlueprint): void {
  const quality = blueprint.quality;
  const passesRubric =
    quality.score >= 85 &&
    quality.structuredOutputValid &&
    quality.criticalIssuesFound === quality.criticalIssuesExpected &&
    quality.criticalFalsePositives === 0;

  if ((quality.gate === "PASSED") !== passesRubric) {
    throw new Error("Demo quality gate is inconsistent with its rubric.");
  }
}

function createComparisonRows(
  scenario: DemoScenario,
  selectedController: DemoController
): readonly ControllerComparisonRow[] {
  const staticBlueprint = getRunBlueprint(scenario.id, "static");
  const staticEligible = staticBlueprint.quality.gate === "PASSED";
  const staticCost = finalSettledMicroUsd(staticBlueprint);

  return DEMO_CONTROLLERS.map((controller) => {
    const blueprint = getRunBlueprint(scenario.id, controller);
    validateQuality(blueprint);
    const settledMicroUsd = finalSettledMicroUsd(blueprint);
    const eligibleForCostComparison =
      blueprint.quality.gate === "PASSED";

    return {
      controller,
      selected: controller === selectedController,
      status: blueprint.status,
      settledMicroUsd,
      applicationCeilingMicroUsd:
        scenario.taskPolicy.applicationCeilingMicroUsd,
      withinCeiling:
        settledMicroUsd <=
        scenario.taskPolicy.applicationCeilingMicroUsd,
      qualityGate: blueprint.quality.gate,
      qualityScore: blueprint.quality.score,
      criticalMisses: Math.max(
        0,
        blueprint.quality.criticalIssuesExpected -
          blueprint.quality.criticalIssuesFound
      ),
      eligibleForCostComparison,
      costDeltaVsStaticMicroUsd:
        eligibleForCostComparison && staticEligible
          ? settledMicroUsd - staticCost
          : null,
      appliedInterventions: appliedInterventionKinds(blueprint).length
    };
  });
}

function createFinalSummary(
  scenario: DemoScenario,
  blueprint: RunBlueprint
): RunFinalSummary {
  const settledMicroUsd = finalSettledMicroUsd(blueprint);
  const qualityGatePassed = blueprint.quality.gate === "PASSED";

  return {
    status: blueprint.status,
    headline: blueprint.headline,
    detail: blueprint.detail,
    settledMicroUsd,
    applicationCeilingMicroUsd:
      scenario.taskPolicy.applicationCeilingMicroUsd,
    unusedMicroUsd:
      scenario.taskPolicy.applicationCeilingMicroUsd -
      settledMicroUsd,
    completedWithinPolicy:
      blueprint.status === "COMPLETED" &&
      settledMicroUsd <=
        scenario.taskPolicy.applicationCeilingMicroUsd,
    qualityGatePassed,
    appliedInterventions: appliedInterventionKinds(blueprint),
    comparisonDisclosure: qualityGatePassed
      ? "Synthetic cost is compared only with controller rows that pass the same quality gate."
      : "This run failed the quality gate; its synthetic cost is not eligible for controller comparison."
  };
}

function scenarioById(id: DemoScenarioId): DemoScenario {
  const scenario = DEMO_SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) {
    throw new Error(`Missing internal demo scenario: ${id}`);
  }
  return scenario;
}

function buildRun(
  scenarioId: DemoScenarioId,
  controller: DemoController
): RunTrace {
  const scenario = scenarioById(scenarioId);
  const blueprint = getRunBlueprint(scenarioId, controller);
  validateQuality(blueprint);
  const id = `demo-run:${scenarioId}:${controller}:v1`;
  const { events, receipts } = buildEvents(id, scenario, blueprint);

  return {
    version: 1,
    id,
    mode: DEMO_MODE,
    truthLabel: DEMO_TRUTH_LABEL,
    provenance: DEMO_PROVENANCE,
    rateCard: DEMO_RATE_CARD,
    scenarioId,
    scenario,
    controller,
    taskPolicy: scenario.taskPolicy,
    status: blueprint.status,
    quality: blueprint.quality,
    events,
    syntheticReceipts: receipts,
    finalSummary: createFinalSummary(scenario, blueprint),
    comparisonRows: createComparisonRows(scenario, controller)
  };
}

function createBenchmarkRows(): readonly BenchmarkComparisonRow[] {
  const rowsWithoutDelta = DEMO_CONTROLLERS.map((controller) => {
    const blueprints = DEMO_SCENARIOS.map((scenario) =>
      getRunBlueprint(scenario.id, controller)
    );
    blueprints.forEach(validateQuality);
    const qualityGatePassed = blueprints.every(
      (blueprint) => blueprint.quality.gate === "PASSED"
    );

    return {
      controller,
      assignedRuns: blueprints.length,
      completedRuns: blueprints.filter(
        (blueprint) => blueprint.status === "COMPLETED"
      ).length,
      qualityPassedRuns: blueprints.filter(
        (blueprint) => blueprint.quality.gate === "PASSED"
      ).length,
      criticalMisses: blueprints.reduce(
        (total, blueprint) =>
          total +
          Math.max(
            0,
            blueprint.quality.criticalIssuesExpected -
              blueprint.quality.criticalIssuesFound
          ),
        0
      ),
      totalSettledMicroUsd: blueprints.reduce(
        (total, blueprint) =>
          total + finalSettledMicroUsd(blueprint),
        0
      ),
      qualityGatePassed,
      eligibleForCostComparison: qualityGatePassed
    };
  });
  const staticRow = rowsWithoutDelta.find(
    (row) => row.controller === "static"
  );
  if (!staticRow) {
    throw new Error("Demo benchmark is missing its static controller.");
  }

  return rowsWithoutDelta.map((row) => ({
    ...row,
    costDeltaVsStaticMicroUsd:
      row.eligibleForCostComparison &&
      staticRow.eligibleForCostComparison
        ? row.totalSettledMicroUsd -
          staticRow.totalSettledMicroUsd
        : null
  }));
}

function buildBenchmark(): DemoBenchmark {
  return {
    id: "pr-review-demo-benchmark-v1",
    title: "Deterministic PR review demo benchmark",
    mode: DEMO_MODE,
    truthLabel: DEMO_TRUTH_LABEL,
    provenance: DEMO_PROVENANCE,
    rateCard: DEMO_RATE_CARD,
    scenarioCount: DEMO_SCENARIOS.length,
    controllers: DEMO_CONTROLLERS,
    qualityGate: {
      id: "pr-review-quality-v1",
      minimumScore: 85,
      requireStructuredOutput: true,
      requireEveryCriticalIssue: true,
      maximumCriticalFalsePositives: 0,
      requireEveryAssignedRun: true
    },
    comparisonRows: createBenchmarkRows(),
    conclusion: "SHADOW_INCREMENTAL_VALUE_NOT_ESTABLISHED",
    disclosure:
      "All tasks, token usage, timings, receipts, and costs are deterministic synthetic demo data. The shadow arm matches static cost, so no incremental prediction or savings claim is made."
  };
}

function parseRunInput(input: unknown): CreateDemoRunInput {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new DemoInputError(
      "INVALID_DEMO_INPUT",
      "Demo run input must be an object with scenarioId and controller."
    );
  }

  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== 2 ||
    !keys.includes("scenarioId") ||
    !keys.includes("controller")
  ) {
    throw new DemoInputError(
      "INVALID_DEMO_INPUT",
      "Demo run input must contain only scenarioId and controller."
    );
  }

  const record = input as Record<string, unknown>;
  const scenarioId = record.scenarioId;
  const controller = record.controller;

  if (
    typeof scenarioId !== "string" ||
    !(DEMO_SCENARIO_IDS as readonly string[]).includes(scenarioId)
  ) {
    throw new DemoInputError(
      "UNKNOWN_SCENARIO",
      `Unknown demo scenario: ${String(scenarioId)}`
    );
  }
  if (
    typeof controller !== "string" ||
    !(DEMO_CONTROLLERS as readonly string[]).includes(controller)
  ) {
    throw new DemoInputError(
      "UNKNOWN_CONTROLLER",
      `Unknown demo controller: ${String(controller)}`
    );
  }

  return {
    scenarioId: scenarioId as DemoScenarioId,
    controller: controller as DemoController
  };
}

export function getDemoCatalog(): DemoCatalog {
  return clone({
    scenarios: DEMO_SCENARIOS,
    benchmark: buildBenchmark()
  });
}

export function createDemoRun(input: CreateDemoRunInput): RunTrace;
export function createDemoRun(input: unknown): RunTrace {
  const parsed = parseRunInput(input);
  return clone(buildRun(parsed.scenarioId, parsed.controller));
}
