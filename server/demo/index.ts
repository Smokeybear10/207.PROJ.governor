import { createHash } from "node:crypto";
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
  GPT_5_4_MINI_STANDARD_RATE_CARD,
  ReservationLedger,
  RetryFingerprintTracker,
  assessLedgerRisk,
  calculateUsageCost,
  createGovernorPolicy,
  type LedgerSnapshot,
  type ProviderUsage,
  type RiskAssessment,
  type RiskDriverCode
} from "../governor/index.js";
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
  type DemoRequestAdmission,
  type EventMetricsSnapshot,
  type InterventionActionKind,
  type ObservedRiskDriver,
  type RunEvent,
  type RunFinalSummary,
  type RunTrace,
  type SyntheticCostReceipt
} from "./types.js";

export * from "./types.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function toSyntheticProviderUsage(usage: UsageSeed): ProviderUsage {
  requireNonNegativeInteger(
    usage.uncachedInputTokens,
    "uncachedInputTokens"
  );
  requireNonNegativeInteger(usage.cachedInputTokens, "cachedInputTokens");
  requireNonNegativeInteger(usage.outputTokens, "outputTokens");

  return {
    inputTokens:
      usage.uncachedInputTokens + usage.cachedInputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    usageSource: "provider"
  };
}

function createSyntheticReceipt(
  runId: string,
  requestNumber: number,
  usage: UsageSeed
): SyntheticCostReceipt {
  const priced = calculateUsageCost(
    GPT_5_4_MINI_STANDARD_RATE_CARD,
    toSyntheticProviderUsage(usage)
  );
  const charge = (kind: "uncached_input" | "cached_input" | "output") =>
    priced.charges.find((candidate) => candidate.kind === kind)?.microUsd ??
    0;

  return {
    id: `${runId}:receipt:${String(requestNumber).padStart(2, "0")}`,
    kind: "SYNTHETIC_COST_RECEIPT",
    requestNumber,
    rateCardVersion: DEMO_RATE_CARD_VERSION,
    rounding: "CEIL_EACH_AGGREGATE_CHARGE",
    usage: { ...usage },
    charges: {
      uncachedInputMicroUsd: charge("uncached_input"),
      cachedInputMicroUsd: charge("cached_input"),
      outputMicroUsd: charge("output")
    },
    totalMicroUsd: priced.totalMicroUsd,
    disclosure: "Synthetic demo calculation; not measured API usage."
  };
}

function protectedFinalReserve(snapshot: LedgerSnapshot): number {
  const stillAvailable =
    !snapshot.closed &&
    snapshot.pendingFinalValidationRequestId === null &&
    snapshot.activeReservation?.phase !== "final" &&
    snapshot.responsesStarted < snapshot.policy.maxResponses;

  return stillAvailable
    ? snapshot.policy.finalAnswerReserveMicroUsd
    : 0;
}

function createMetrics(
  scenario: DemoScenario,
  seed: EventSeed["metrics"],
  snapshot: LedgerSnapshot
): EventMetricsSnapshot {
  const numericEntries = Object.entries(seed) as Array<
    [keyof typeof seed, number]
  >;
  for (const [key, value] of numericEntries) {
    requireNonNegativeInteger(value, String(key));
  }

  const finalReserveMicroUsd = protectedFinalReserve(snapshot);
  const committed =
    snapshot.settledMicroUsd +
    snapshot.outstandingReservedMicroUsd +
    finalReserveMicroUsd;
  const remainingMicroUsd =
    scenario.taskPolicy.applicationCeilingMicroUsd - committed;
  if (remainingMicroUsd < 0) {
    throw new Error(
      `Demo fixture ${scenario.id} exceeds its application ceiling.`
    );
  }

  return {
    settledMicroUsd: snapshot.settledMicroUsd,
    reservedMicroUsd: snapshot.outstandingReservedMicroUsd,
    finalReserveMicroUsd,
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

const CORE_RISK_DRIVER_LABELS: Record<RiskDriverCode, string> = {
  NO_STATIC_COMPLETION_PATH: "No static completion path",
  FINAL_RESERVE_PRESSURE: "Final reserve pressure",
  BUDGET_UTILIZATION: "Budget utilization",
  CONTEXT_GROWTH: "Context growth",
  EQUIVALENT_RETRIES: "Equivalent retry limit",
  FAILED_TOOL_CALLS: "Repeated tool failures",
  NO_RESPONSES_REMAINING: "No responses remaining"
};

function createLedger(scenario: DemoScenario): ReservationLedger {
  if (
    GPT_5_4_MINI_STANDARD_RATE_CARD.version !==
    DEMO_RATE_CARD_VERSION
  ) {
    throw new Error("The demo and governor core rate cards do not match.");
  }

  const taskPolicy = scenario.taskPolicy;
  return new ReservationLedger(
    createGovernorPolicy({
      applicationCeilingMicroUsd:
        taskPolicy.applicationCeilingMicroUsd,
      finalAnswerReserveMicroUsd:
        taskPolicy.protectedFinalReserveMicroUsd,
      finalAnswerInputTokenLimit:
        taskPolicy.finalAnswerInputTokenLimit,
      minimumFinalOutputTokens:
        taskPolicy.minimumFinalOutputTokens,
      maxResponses: taskPolicy.maxResponses,
      maxEquivalentRetries: taskPolicy.maxEquivalentRetries,
      rateCardVersion: taskPolicy.rateCardVersion
    }),
    GPT_5_4_MINI_STANDARD_RATE_CARD
  );
}

function coreRiskDrivers(
  assessment: RiskAssessment
): readonly ObservedRiskDriver[] {
  return assessment.drivers.map((driver) => ({
    id: `governor-core-${driver.code.toLowerCase().replaceAll("_", "-")}`,
    direction: "INCREASES_RISK" as const,
    label: CORE_RISK_DRIVER_LABELS[driver.code],
    evidence: driver.evidence
  }));
}

function createEventRisk(
  seed: EventSeed,
  assessment: RiskAssessment
): RunEvent["risk"] {
  const narrativeDrivers = clone(seed.risk.observedDrivers);
  const observedIds = new Set(
    narrativeDrivers.map((driver) => driver.id)
  );
  const derivedDrivers = coreRiskDrivers(assessment).filter(
    (driver) => !observedIds.has(driver.id)
  );

  return {
    ...clone(seed.risk),
    band: assessment.band,
    engine: "GOVERNOR_CORE",
    observedDrivers: [...narrativeDrivers, ...derivedDrivers]
  };
}

function buildEvents(
  runId: string,
  scenario: DemoScenario,
  blueprint: RunBlueprint
): BuiltEvents {
  const ledger = createLedger(scenario);
  const retryTracker = new RetryFingerprintTracker(
    scenario.taskPolicy.maxEquivalentRetries
  );
  const pricingIdentity = ledger.getPricingIdentity();
  let requestNumber = 0;
  let receiptNumber = 0;
  let settledFromReceipts = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let failedToolCalls = 0;
  let equivalentRetryCount = 0;
  let activeRequestId: string | null = null;
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
    let syntheticReceipt: SyntheticCostReceipt | undefined;
    let requestAdmission: DemoRequestAdmission | undefined;

    if (seed.type === "REQUEST_ADMITTED") {
      if (!seed.request) {
        throw new Error(
          `Demo fixture ${scenario.id} is missing request admission data at event ${sequence}.`
        );
      }
      requestNumber += 1;
      const requestId = `${runId}:request:${String(requestNumber).padStart(
        2,
        "0"
      )}`;
      const admission = ledger.reserve({
        requestId,
        exactInputTokens: seed.request.exactInputTokens,
        requestedMaxOutputTokens:
          seed.request.requestedMaxOutputTokens,
        minimumUsefulOutputTokens:
          seed.request.minimumUsefulOutputTokens,
        phase: seed.request.phase,
        binding: {
          contextSha256: digest(`${requestId}:synthetic-context`),
          model: pricingIdentity.model,
          serviceTier: pricingIdentity.requestServiceTier,
          processingRegion: pricingIdentity.processingRegion
        }
      });
      if (!admission.admitted) {
        throw new Error(
          `Demo fixture ${scenario.id} was denied by the governor core at event ${sequence}: ${admission.reason}.`
        );
      }
      ledger.dispatch(requestId, {
        requestSha256: digest(`${requestId}:synthetic-request`)
      });
      activeRequestId = requestId;
      requestAdmission = {
        requestId,
        phase: seed.request.phase,
        exactInputTokens: seed.request.exactInputTokens,
        requestedMaxOutputTokens:
          seed.request.requestedMaxOutputTokens,
        minimumUsefulOutputTokens:
          seed.request.minimumUsefulOutputTokens,
        admittedMaxOutputTokens:
          admission.reservation.maxOutputTokens
      };
    } else if (seed.request) {
      throw new Error(
        `Demo fixture ${scenario.id} attached admission data to ${seed.type}.`
      );
    }

    if (seed.type === "RESPONSE_SETTLED") {
      if (!seed.receiptUsage || activeRequestId === null) {
        throw new Error(
          `Demo fixture ${scenario.id} cannot settle event ${sequence} without an active request and synthetic usage.`
        );
      }
      receiptNumber += 1;
      syntheticReceipt = createSyntheticReceipt(
        runId,
        receiptNumber,
        seed.receiptUsage
      );
      receipts.push(syntheticReceipt);
      settledFromReceipts += syntheticReceipt.totalMicroUsd;
      const settlement = ledger.settle(
        activeRequestId,
        toSyntheticProviderUsage(seed.receiptUsage),
        {
          id: `${runId}:synthetic-response:${String(
            receiptNumber
          ).padStart(2, "0")}`,
          model: pricingIdentity.model,
          serviceTier: pricingIdentity.requestServiceTier,
          status: "completed"
        }
      );
      if (settlement.settledMicroUsd !== syntheticReceipt.totalMicroUsd) {
        throw new Error(
          `Demo fixture ${scenario.id} diverged from governor settlement at event ${sequence}.`
        );
      }
      activeRequestId = null;
      uncachedInputTokens +=
        syntheticReceipt.usage.uncachedInputTokens;
      cachedInputTokens += syntheticReceipt.usage.cachedInputTokens;
      outputTokens += syntheticReceipt.usage.outputTokens;
    } else if (seed.receiptUsage) {
      throw new Error(
        `Demo fixture ${scenario.id} attached usage to ${seed.type}.`
      );
    }

    if (seed.retryAttempt) {
      const retryObservation = retryTracker.observe(seed.retryAttempt);
      equivalentRetryCount =
        retryObservation.equivalentRetryCount;
      if (
        seed.type === "RETRY_REJECTED" &&
        retryObservation.retryAllowed
      ) {
        throw new Error(
          `Demo fixture ${scenario.id} rejected a retry before the core limit was reached.`
        );
      }
      if (
        seed.type !== "RETRY_REJECTED" &&
        !retryObservation.retryAllowed
      ) {
        throw new Error(
          `Demo fixture ${scenario.id} admitted retry work after the core limit was reached.`
        );
      }
    }
    if (seed.failedToolCall) {
      failedToolCalls += 1;
    }

    if (seed.type === "QUALITY_EVALUATED") {
      const pendingFinalRequestId =
        ledger.getSnapshot().pendingFinalValidationRequestId;
      if (pendingFinalRequestId !== null) {
        ledger.finalizeFinalResponse(
          pendingFinalRequestId,
          blueprint.quality.gate === "PASSED"
        );
      } else if (blueprint.status === "COMPLETED") {
        throw new Error(
          `Demo fixture ${scenario.id} completed without final-response validation.`
        );
      }
    }
    if (seed.type === "RUN_STOPPED") {
      ledger.closeStoppedJob();
    }

    const snapshot = ledger.getSnapshot();
    if (
      seed.type === "RUN_COMPLETED" &&
      (!snapshot.closed || snapshot.completionAccepted !== true)
    ) {
      throw new Error(
        `Demo fixture ${scenario.id} reached completion before the governor ledger closed.`
      );
    }
    const metrics = createMetrics(scenario, seed.metrics, snapshot);

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

    const assessment = assessLedgerRisk(snapshot, {
      minimumCompletionCostMicroUsd:
        seed.minimumCompletionCostMicroUsd ?? 0,
      baselineContextTokens: scenario.initialContextTokens,
      currentContextTokens: metrics.contextTokens,
      equivalentRetryCount,
      failedToolCalls
    });
    const event: RunEvent = {
      id: eventId,
      sequence,
      offsetMs: seed.offsetMs,
      type: seed.type,
      title: seed.title,
      detail: seed.detail,
      metrics,
      risk: createEventRisk(seed, assessment),
      ...(requestAdmission ? { requestAdmission } : {}),
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
    if (seed.type === "RETRY_REJECTED") {
      equivalentRetryCount = 0;
    }
    return event;
  });

  const terminalEvent = events.at(-1);
  const expectedTerminalType =
    blueprint.status === "COMPLETED" ? "RUN_COMPLETED" : "RUN_STOPPED";
  if (!terminalEvent || terminalEvent.type !== expectedTerminalType) {
    throw new Error(
      `Demo fixture ${scenario.id} does not end in ${expectedTerminalType}.`
    );
  }
  const finalSnapshot = ledger.getSnapshot();
  if (
    !finalSnapshot.closed ||
    finalSnapshot.completionAccepted !==
      (blueprint.status === "COMPLETED")
  ) {
    throw new Error(
      `Demo fixture ${scenario.id} did not reach its expected governor terminal state.`
    );
  }

  return { events, receipts };
}

function finalSettledMicroUsd(blueprint: RunBlueprint): number {
  if (blueprint.events.length === 0) {
    throw new Error("Demo run blueprints must contain at least one event.");
  }
  const total = blueprint.events.reduce(
    (settledMicroUsd, event) =>
      settledMicroUsd +
      (event.receiptUsage
        ? calculateUsageCost(
            GPT_5_4_MINI_STANDARD_RATE_CARD,
            toSyntheticProviderUsage(event.receiptUsage)
          ).totalMicroUsd
        : 0),
    0
  );
  requireNonNegativeInteger(total, "Demo settled cost");
  return total;
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
