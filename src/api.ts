export type Controller = "hard_cap" | "static" | "shadow";

export type RiskBand = "SAFE" | "WATCH" | "AT_RISK";

export type QualityGate = "PASS" | "FAIL";

export const DEMO_TRUTH_LABEL =
  "DEMO: deterministic synthetic simulation; no external model or provider API calls were made." as const;

export type DemoProvenance = {
  origin: "SYNTHETIC_DETERMINISTIC_FIXTURE";
  governorCore: "GOVERNOR_CORE_ENFORCED";
  externalApiCalls: 0;
  usageSource: "SIMULATED";
  costBasis: "SIMULATED_LIST_PRICE_MICRO_USD";
};

export type DemoRateCard = {
  version: string;
  provider: string;
  model: string;
  serviceTier: string;
  processingRegion: string;
  currency: "USD";
  unit: "USD_PER_MILLION_TOKENS";
  uncachedInputUsdPerMillionTokens: number;
  cachedInputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  uncachedInputMicroUsdPerMillionTokens: number;
  cachedInputMicroUsdPerMillionTokens: number;
  outputMicroUsdPerMillionTokens: number;
  rounding: "CEIL_EACH_AGGREGATE_CHARGE";
  source: "PINNED_STANDARD_PRICING_FOR_DEMO";
  disclosure: string;
};

export type DemoTruth = {
  truthLabel: typeof DEMO_TRUTH_LABEL;
  provenance: DemoProvenance;
  rateCard: DemoRateCard;
};

export type ScenarioSummary = {
  id: string;
  name: string;
  description: string;
  repository?: string;
  pullRequest?: string;
  changedFiles?: number;
  changedLines?: number;
  initialContextTokens?: number;
  ceilingMicros?: number;
  finalReserveMicros?: number;
  signals?: string[];
};

export type CostRange = {
  lowMicros: number;
  highMicros: number;
  sampleCount: number;
};

export type BenchmarkRow = {
  controller: Controller;
  label: string;
  scope: "aggregate" | "scenario";
  qualityGate: QualityGate;
  fixtureRubricScore: number | null;
  aggregatePassRate: number | null;
  criticalMisses: number;
  passedRuns: number;
  totalRuns: number;
  totalCostMicros: number;
  policyStops: number;
  interventions: number | null;
  eligibleForCostComparison: boolean;
  costDeltaVsStaticMicros: number | null;
  selected: boolean;
};

export type DemoCatalog = DemoTruth & {
  scenarios: ScenarioSummary[];
  benchmark: BenchmarkRow[];
  benchmarkDisclosure: string;
};

export type EventMetrics = {
  settledMicros: number;
  reservedMicros: number;
  finalReserveMicros: number;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
};

export type TraceAction = {
  label: string;
  detail: string;
  mode: "deterministic" | "shadow";
  execution: "APPLIED" | "RECOMMENDED";
  source: "HARD_CAP" | "STATIC_GUARDRAIL" | "SHADOW_FORECAST";
};

export type RequestAdmission = {
  phase: "work" | "final";
  exactInputTokens: number;
  requestedMaxOutputTokens: number;
  minimumUsefulOutputTokens: number;
  admittedMaxOutputTokens: number;
};

export type RunEvent = {
  id: string;
  offsetMs: number;
  phase: string;
  kind: string;
  title: string;
  detail: string;
  risk: RiskBand;
  metrics: EventMetrics;
  drivers?: string[];
  requestAdmission?: RequestAdmission;
  action?: TraceAction | string;
};

export type RunPolicy = {
  name: string;
  ceilingMicros: number;
  finalReserveMicros: number;
};

export type QualityResult = {
  gate: QualityGate;
  score: number;
  label: string;
  criticalMisses: number;
};

export type RunSummary = {
  outcome: string;
  durationMs: number;
  settledMicros: number;
  inputTokens: number;
  outputTokens: number;
  interventions: number;
  policyStops: number;
};

export type RunStatus = "COMPLETED" | "STOPPED";

export type RunTrace = DemoTruth & {
  id: string;
  mode: "DEMO";
  scenario: ScenarioSummary;
  controller: Controller;
  policy: RunPolicy;
  status: RunStatus;
  quality: QualityResult;
  events: RunEvent[];
  summary: RunSummary;
  comparison: BenchmarkRow[];
  comparisonDisclosure: string;
};

export type CreateDemoRunInput = {
  scenarioId: string;
  controller: Controller;
};

type DetailedScenario = {
  id: string;
  title: string;
  summary: string;
  repository?: string;
  pullRequestNumber?: number;
  changedFiles?: number;
  changedLines?: number;
  initialContextTokens?: number;
  signals?: string[];
  taskPolicy?: {
    applicationCeilingMicroUsd?: number;
    protectedFinalReserveMicroUsd?: number;
  };
};

type DetailedBenchmarkRow = {
  controller: Controller;
  assignedRuns: number;
  completedRuns: number;
  qualityPassedRuns: number;
  criticalMisses: number;
  totalSettledMicroUsd: number;
  qualityGatePassed: boolean;
  eligibleForCostComparison: boolean;
  costDeltaVsStaticMicroUsd: number | null;
};

type DetailedEvent = {
  id: string;
  offsetMs: number;
  type: string;
  title: string;
  detail: string;
  metrics: {
    settledMicroUsd: number;
    reservedMicroUsd: number;
    finalReserveMicroUsd: number;
    inputTokens: number;
    outputTokens: number;
    contextTokens: number;
  };
  risk: {
    band: RiskBand;
    engine: "GOVERNOR_CORE";
    observedDrivers?: Array<{
      label: string;
      evidence: string;
    }>;
  };
  requestAdmission?: {
    phase: "work" | "final";
    exactInputTokens: number;
    requestedMaxOutputTokens: number;
    minimumUsefulOutputTokens: number;
    admittedMaxOutputTokens: number;
  };
  action?: {
    kind: string;
    source: string;
    execution: string;
    summary: string;
    reason: string;
  };
};

type DetailedComparisonRow = {
  controller: Controller;
  selected: boolean;
  status: string;
  settledMicroUsd: number;
  applicationCeilingMicroUsd: number;
  withinCeiling: boolean;
  qualityGate: string;
  qualityScore: number;
  criticalMisses: number;
  eligibleForCostComparison: boolean;
  costDeltaVsStaticMicroUsd: number | null;
  appliedInterventions: number;
};

const CONTROLLER_LABELS: Record<Controller, string> = {
  hard_cap: "Hard cap",
  static: "Static rules",
  shadow: "Static + shadow annotation"
};

const EVENT_PRESENTATION: Record<string, { phase: string; kind: string }> = {
  RUN_STARTED: { phase: "START", kind: "RUN" },
  REQUEST_ADMITTED: { phase: "ADMISSION", kind: "RESERVATION" },
  RESPONSE_SETTLED: { phase: "SETTLEMENT", kind: "MODEL_RESPONSE" },
  TOOL_RESULT: { phase: "OBSERVATION", kind: "TOOL_RESULT" },
  RISK_EVALUATED: { phase: "FORECAST", kind: "RISK" },
  INTERVENTION: { phase: "CONTROL", kind: "INTERVENTION" },
  RETRY_REJECTED: { phase: "CONTROL", kind: "RETRY_REJECTED" },
  QUALITY_EVALUATED: { phase: "EVALUATION", kind: "QUALITY_GATE" },
  RUN_COMPLETED: { phase: "COMPLETE", kind: "RUN" },
  RUN_STOPPED: { phase: "STOP", kind: "POLICY" }
};

const MAX_SCRIPTED_EVENTS = 250;
const MAX_SCRIPTED_OFFSET_MS = 10 * 60 * 1_000;

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isController(value: unknown): value is Controller {
  return value === "hard_cap" || value === "static" || value === "shadow";
}

function isRiskBand(value: unknown): value is RiskBand {
  return value === "SAFE" || value === "WATCH" || value === "AT_RISK";
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(`${label} is missing from the demo contract.`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ApiError(`${label} is invalid in the demo contract.`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  const number = requireNumber(value, label);
  if (!Number.isSafeInteger(number)) {
    throw new ApiError(`${label} must be a non-negative safe integer.`);
  }
  return number;
}

function validateCostDelta(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError(`${label} is invalid in the demo contract.`);
  }
  return value;
}

function validateTruth(value: Record<string, unknown>, label: string): DemoTruth {
  if (value.mode !== "DEMO" || value.truthLabel !== DEMO_TRUTH_LABEL) {
    throw new ApiError(
      `${label} is missing the required deterministic demo truth label.`
    );
  }
  if (!isRecord(value.provenance)) {
    throw new ApiError(`${label} is missing detailed demo provenance.`);
  }

  const provenance = value.provenance;
  if (
    provenance.origin !== "SYNTHETIC_DETERMINISTIC_FIXTURE" ||
    provenance.governorCore !== "GOVERNOR_CORE_ENFORCED" ||
    provenance.externalApiCalls !== 0 ||
    provenance.usageSource !== "SIMULATED" ||
    provenance.costBasis !== "SIMULATED_LIST_PRICE_MICRO_USD"
  ) {
    throw new ApiError(`${label} contained untrusted demo provenance.`);
  }
  if (!isRecord(value.rateCard)) {
    throw new ApiError(`${label} is missing its pinned synthetic rate card.`);
  }

  const rateCard = value.rateCard;
  if (
    rateCard.currency !== "USD" ||
    rateCard.unit !== "USD_PER_MILLION_TOKENS" ||
    rateCard.rounding !== "CEIL_EACH_AGGREGATE_CHARGE" ||
    rateCard.source !== "PINNED_STANDARD_PRICING_FOR_DEMO"
  ) {
    throw new ApiError(`${label} contained an unsupported demo rate card.`);
  }

  return {
    truthLabel: DEMO_TRUTH_LABEL,
    provenance: {
      origin: "SYNTHETIC_DETERMINISTIC_FIXTURE",
      governorCore: "GOVERNOR_CORE_ENFORCED",
      externalApiCalls: 0,
      usageSource: "SIMULATED",
      costBasis: "SIMULATED_LIST_PRICE_MICRO_USD"
    },
    rateCard: {
      version: requireString(rateCard.version, `${label} rateCard.version`),
      provider: requireString(rateCard.provider, `${label} rateCard.provider`),
      model: requireString(rateCard.model, `${label} rateCard.model`),
      serviceTier: requireString(
        rateCard.serviceTier,
        `${label} rateCard.serviceTier`
      ),
      processingRegion: requireString(
        rateCard.processingRegion,
        `${label} rateCard.processingRegion`
      ),
      currency: "USD",
      unit: "USD_PER_MILLION_TOKENS",
      uncachedInputUsdPerMillionTokens: requireNumber(
        rateCard.uncachedInputUsdPerMillionTokens,
        `${label} uncached input USD rate`
      ),
      cachedInputUsdPerMillionTokens: requireNumber(
        rateCard.cachedInputUsdPerMillionTokens,
        `${label} cached input USD rate`
      ),
      outputUsdPerMillionTokens: requireNumber(
        rateCard.outputUsdPerMillionTokens,
        `${label} output USD rate`
      ),
      uncachedInputMicroUsdPerMillionTokens: requireInteger(
        rateCard.uncachedInputMicroUsdPerMillionTokens,
        `${label} uncached input micro-USD rate`
      ),
      cachedInputMicroUsdPerMillionTokens: requireInteger(
        rateCard.cachedInputMicroUsdPerMillionTokens,
        `${label} cached input micro-USD rate`
      ),
      outputMicroUsdPerMillionTokens: requireInteger(
        rateCard.outputMicroUsdPerMillionTokens,
        `${label} output micro-USD rate`
      ),
      rounding: "CEIL_EACH_AGGREGATE_CHARGE",
      source: "PINNED_STANDARD_PRICING_FOR_DEMO",
      disclosure: requireString(
        rateCard.disclosure,
        `${label} rateCard.disclosure`
      )
    }
  };
}

function toScenario(value: unknown): ScenarioSummary {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new ApiError("Catalog contained an invalid scenario.");
  }

  const detailed = value as unknown as DetailedScenario;
  if (
    typeof detailed.title !== "string" ||
    typeof detailed.summary !== "string"
  ) {
    throw new ApiError("Catalog scenario is missing its title or summary.");
  }

  const optionalCount = (candidate: unknown): number | undefined =>
    typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0
      ? candidate
      : undefined;

  return {
    id: detailed.id,
    name: detailed.title,
    description: detailed.summary,
    repository: detailed.repository,
    pullRequest:
      typeof detailed.pullRequestNumber === "number"
        ? `PR #${detailed.pullRequestNumber}`
        : undefined,
    changedFiles: optionalCount(detailed.changedFiles),
    changedLines: optionalCount(detailed.changedLines),
    initialContextTokens: optionalCount(detailed.initialContextTokens),
    ceilingMicros: optionalCount(
      detailed.taskPolicy?.applicationCeilingMicroUsd
    ),
    finalReserveMicros: optionalCount(
      detailed.taskPolicy?.protectedFinalReserveMicroUsd
    ),
    signals: Array.isArray(detailed.signals)
      ? detailed.signals.filter(
          (signal): signal is string => typeof signal === "string"
        )
      : undefined
  };
}

function toBenchmarkRow(value: unknown): BenchmarkRow {
  if (!isRecord(value) || !isController(value.controller)) {
    throw new ApiError("Benchmark contained an invalid controller row.");
  }

  const row = value as unknown as DetailedBenchmarkRow;
  if (
    typeof row.qualityGatePassed !== "boolean" ||
    typeof row.eligibleForCostComparison !== "boolean"
  ) {
    throw new ApiError("Benchmark row did not match the demo contract.");
  }

  const assignedRuns = requireInteger(
    row.assignedRuns,
    "Benchmark assignedRuns"
  );
  const completedRuns = requireInteger(
    row.completedRuns,
    "Benchmark completedRuns"
  );
  const qualityPassedRuns = requireInteger(
    row.qualityPassedRuns,
    "Benchmark qualityPassedRuns"
  );

  return {
    controller: row.controller,
    label: CONTROLLER_LABELS[row.controller],
    scope: "aggregate",
    qualityGate: row.qualityGatePassed ? "PASS" : "FAIL",
    fixtureRubricScore: null,
    aggregatePassRate:
      assignedRuns > 0 ? (qualityPassedRuns / assignedRuns) * 100 : 0,
    criticalMisses: requireInteger(
      row.criticalMisses,
      "Benchmark criticalMisses"
    ),
    passedRuns: qualityPassedRuns,
    totalRuns: assignedRuns,
    totalCostMicros: requireInteger(
      row.totalSettledMicroUsd,
      "Benchmark totalSettledMicroUsd"
    ),
    policyStops: Math.max(0, assignedRuns - completedRuns),
    interventions: null,
    eligibleForCostComparison: row.eligibleForCostComparison,
    costDeltaVsStaticMicros: validateCostDelta(
      row.costDeltaVsStaticMicroUsd,
      "Benchmark costDeltaVsStaticMicroUsd"
    ),
    selected: false
  };
}

function validateCatalog(value: unknown): DemoCatalog {
  if (
    !isRecord(value) ||
    !Array.isArray(value.scenarios) ||
    !isRecord(value.benchmark)
  ) {
    throw new ApiError(
      "Catalog response did not match the detailed DEMO catalog contract."
    );
  }

  const benchmarkValue = value.benchmark;
  if (!Array.isArray(benchmarkValue.comparisonRows)) {
    throw new ApiError(
      "Catalog response did not include benchmark comparison rows."
    );
  }
  const truth = validateTruth(benchmarkValue, "Catalog benchmark");

  return {
    ...truth,
    scenarios: value.scenarios.map(toScenario),
    benchmark: benchmarkValue.comparisonRows.map(toBenchmarkRow),
    benchmarkDisclosure: requireString(
      benchmarkValue.disclosure,
      "Catalog benchmark disclosure"
    )
  };
}

function toDetailedEvent(value: unknown): RunEvent {
  if (!isRecord(value)) {
    throw new ApiError("Run trace contained an invalid event.");
  }

  const event = value as unknown as DetailedEvent;
  if (
    typeof event.id !== "string" ||
    typeof event.offsetMs !== "number" ||
    typeof event.type !== "string" ||
    typeof event.title !== "string" ||
    typeof event.detail !== "string" ||
    !isRecord(event.metrics) ||
    !isRecord(event.risk) ||
    !isRiskBand(event.risk.band) ||
    event.risk.engine !== "GOVERNOR_CORE"
  ) {
    throw new ApiError("Run event did not match the demo contract.");
  }

  const presentation = EVENT_PRESENTATION[event.type] ?? {
    phase: "TRACE",
    kind: event.type
  };
  if (
    event.risk.observedDrivers !== undefined &&
    !Array.isArray(event.risk.observedDrivers)
  ) {
    throw new ApiError("Run event contained invalid risk drivers.");
  }
  const drivers = event.risk.observedDrivers?.map((driver) => {
    if (
      !isRecord(driver) ||
      typeof driver.label !== "string" ||
      typeof driver.evidence !== "string"
    ) {
      throw new ApiError("Run event contained an invalid risk driver.");
    }
    return `${driver.label}: ${driver.evidence}`;
  });
  let action: TraceAction | undefined;
  if (event.action) {
    if (
      !isRecord(event.action) ||
      typeof event.action.summary !== "string" ||
      typeof event.action.reason !== "string" ||
      (event.action.execution !== "APPLIED" &&
        event.action.execution !== "RECOMMENDED") ||
      (event.action.source !== "HARD_CAP" &&
        event.action.source !== "STATIC_GUARDRAIL" &&
        event.action.source !== "SHADOW_FORECAST")
    ) {
      throw new ApiError("Run event contained an invalid controller action.");
    }
    action = {
      label: event.action.summary,
      detail: event.action.reason,
      mode:
        event.action.execution === "RECOMMENDED" ||
        event.action.source === "SHADOW_FORECAST"
          ? "shadow"
          : "deterministic",
      execution: event.action.execution,
      source: event.action.source
    };
  }
  let requestAdmission: RequestAdmission | undefined;
  if (event.requestAdmission) {
    if (
      !isRecord(event.requestAdmission) ||
      (event.requestAdmission.phase !== "work" &&
        event.requestAdmission.phase !== "final")
    ) {
      throw new ApiError(
        "Run event contained an invalid governor admission."
      );
    }
    requestAdmission = {
      phase: event.requestAdmission.phase,
      exactInputTokens: requireInteger(
        event.requestAdmission.exactInputTokens,
        "Run admission exactInputTokens"
      ),
      requestedMaxOutputTokens: requireInteger(
        event.requestAdmission.requestedMaxOutputTokens,
        "Run admission requestedMaxOutputTokens"
      ),
      minimumUsefulOutputTokens: requireInteger(
        event.requestAdmission.minimumUsefulOutputTokens,
        "Run admission minimumUsefulOutputTokens"
      ),
      admittedMaxOutputTokens: requireInteger(
        event.requestAdmission.admittedMaxOutputTokens,
        "Run admission admittedMaxOutputTokens"
      )
    };
  }

  return {
    id: event.id,
    offsetMs: requireInteger(event.offsetMs, "Run event offsetMs"),
    phase: presentation.phase,
    kind: presentation.kind,
    title: event.title,
    detail: event.detail,
    risk: event.risk.band,
    metrics: {
      settledMicros: requireInteger(
        event.metrics.settledMicroUsd,
        "Run event settledMicroUsd"
      ),
      reservedMicros: requireInteger(
        event.metrics.reservedMicroUsd,
        "Run event reservedMicroUsd"
      ),
      finalReserveMicros: requireInteger(
        event.metrics.finalReserveMicroUsd,
        "Run event finalReserveMicroUsd"
      ),
      inputTokens: requireInteger(
        event.metrics.inputTokens,
        "Run event inputTokens"
      ),
      outputTokens: requireInteger(
        event.metrics.outputTokens,
        "Run event outputTokens"
      ),
      contextTokens: requireInteger(
        event.metrics.contextTokens,
        "Run event contextTokens"
      )
    },
    drivers: drivers?.length ? drivers : undefined,
    requestAdmission,
    action
  };
}

function toDetailedComparisonRow(value: unknown): BenchmarkRow {
  if (!isRecord(value) || !isController(value.controller)) {
    throw new ApiError("Run comparison contained an invalid controller row.");
  }

  const row = value as unknown as DetailedComparisonRow;
  if (
    typeof row.selected !== "boolean" ||
    typeof row.withinCeiling !== "boolean" ||
    typeof row.eligibleForCostComparison !== "boolean" ||
    (row.status !== "COMPLETED" && row.status !== "POLICY_STOPPED") ||
    (row.qualityGate !== "PASSED" && row.qualityGate !== "FAILED")
  ) {
    throw new ApiError("Run comparison row did not match the demo contract.");
  }

  return {
    controller: row.controller,
    label: CONTROLLER_LABELS[row.controller],
    scope: "scenario",
    qualityGate: row.qualityGate === "PASSED" ? "PASS" : "FAIL",
    fixtureRubricScore: requireNumber(
      row.qualityScore,
      "Run comparison qualityScore"
    ),
    aggregatePassRate: null,
    criticalMisses: requireInteger(
      row.criticalMisses,
      "Run comparison criticalMisses"
    ),
    passedRuns:
      row.status === "COMPLETED" && row.qualityGate === "PASSED" ? 1 : 0,
    totalRuns: 1,
    totalCostMicros: requireInteger(
      row.settledMicroUsd,
      "Run comparison settledMicroUsd"
    ),
    policyStops: row.status === "POLICY_STOPPED" ? 1 : 0,
    interventions: requireInteger(
      row.appliedInterventions,
      "Run comparison appliedInterventions"
    ),
    eligibleForCostComparison: row.eligibleForCostComparison,
    costDeltaVsStaticMicros: validateCostDelta(
      row.costDeltaVsStaticMicroUsd,
      "Run comparison costDeltaVsStaticMicroUsd"
    ),
    selected: row.selected
  };
}

function normalizeDetailedRun(value: Record<string, unknown>): RunTrace {
  if (
    !isRecord(value.scenario) ||
    !isRecord(value.taskPolicy) ||
    !isRecord(value.quality) ||
    !isRecord(value.finalSummary) ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.syntheticReceipts) ||
    !Array.isArray(value.comparisonRows) ||
    !isController(value.controller)
  ) {
    throw new ApiError(
      "Run response did not match the detailed DEMO RunTrace contract."
    );
  }

  const policy = value.taskPolicy;
  const quality = value.quality;
  const finalSummary = value.finalSummary;
  const truth = validateTruth(value, "Run response");
  if (
    typeof policy.rateCardVersion !== "string" ||
    policy.rateCardVersion !== truth.rateCard.version
  ) {
    throw new ApiError(
      "Run policy rate card does not match the disclosed synthetic rate card."
    );
  }
  for (const receipt of value.syntheticReceipts) {
    if (
      !isRecord(receipt) ||
      receipt.kind !== "SYNTHETIC_COST_RECEIPT" ||
      receipt.rateCardVersion !== truth.rateCard.version ||
      typeof receipt.disclosure !== "string" ||
      !receipt.disclosure.includes("not measured API usage")
    ) {
      throw new ApiError(
        "Run response contained an invalid synthetic cost receipt."
      );
    }
  }
  const events = value.events.map(toDetailedEvent);
  if (events.length === 0) {
    throw new ApiError("Run response did not include a scripted event trace.");
  }
  if (events.length > MAX_SCRIPTED_EVENTS) {
    throw new ApiError("Run response contained too many scripted events.");
  }
  const eventIds = new Set<string>();
  let previousOffset = -1;
  for (const event of events) {
    if (eventIds.has(event.id)) {
      throw new ApiError("Run response contained duplicate event IDs.");
    }
    if (
      event.offsetMs <= previousOffset ||
      event.offsetMs > MAX_SCRIPTED_OFFSET_MS
    ) {
      throw new ApiError(
        "Run response contained an invalid scripted event timeline."
      );
    }
    eventIds.add(event.id);
    previousOffset = event.offsetMs;
  }
  const finalMetrics = events[events.length - 1]?.metrics;
  if (value.status !== "COMPLETED" && value.status !== "POLICY_STOPPED") {
    throw new ApiError("Run response contained an invalid terminal status.");
  }
  const status: RunStatus = value.status === "POLICY_STOPPED" ? "STOPPED" : "COMPLETED";
  if (
    finalSummary.status !== value.status ||
    (quality.gate !== "PASSED" && quality.gate !== "FAILED")
  ) {
    throw new ApiError("Run response contained an inconsistent scripted outcome.");
  }
  const appliedInterventions = Array.isArray(
    finalSummary.appliedInterventions
  )
    ? finalSummary.appliedInterventions.length
    : events.filter((event) => event.action).length;
  const criticalExpected =
    typeof quality.criticalIssuesExpected === "number"
      ? quality.criticalIssuesExpected
      : 0;
  const criticalFound =
    typeof quality.criticalIssuesFound === "number"
      ? quality.criticalIssuesFound
      : 0;

  return {
    ...truth,
    id: String(value.id),
    mode: "DEMO",
    scenario: toScenario(value.scenario),
    controller: value.controller,
    policy: {
      name: requireString(policy.name, "Run policy name"),
      ceilingMicros: requireInteger(
        policy.applicationCeilingMicroUsd,
        "Run policy applicationCeilingMicroUsd"
      ),
      finalReserveMicros: requireInteger(
        policy.protectedFinalReserveMicroUsd,
        "Run policy protectedFinalReserveMicroUsd"
      )
    },
    status,
    quality: {
      gate: quality.gate === "PASSED" ? "PASS" : "FAIL",
      score: requireNumber(quality.score, "Run quality score"),
      label: requireString(quality.summary, "Run quality summary"),
      criticalMisses: Math.max(0, criticalExpected - criticalFound)
    },
    events,
    summary: {
      outcome: requireString(finalSummary.headline, "Run final headline"),
      durationMs: events[events.length - 1]?.offsetMs ?? 0,
      settledMicros: requireInteger(
        finalSummary.settledMicroUsd,
        "Run final settledMicroUsd"
      ),
      inputTokens: finalMetrics?.inputTokens ?? 0,
      outputTokens: finalMetrics?.outputTokens ?? 0,
      interventions: appliedInterventions,
      policyStops: status === "STOPPED" ? 1 : 0
    },
    comparison: value.comparisonRows.map(toDetailedComparisonRow),
    comparisonDisclosure: requireString(
      finalSummary.comparisonDisclosure,
      "Run comparison disclosure"
    )
  };
}

function validateRunTrace(
  value: unknown,
  expected: CreateDemoRunInput
): RunTrace {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.mode !== "DEMO" ||
    typeof value.id !== "string" ||
    !Array.isArray(value.events)
  ) {
    throw new ApiError(
      "Run response did not match the agreed DEMO RunTrace contract."
    );
  }

  if (
    value.scenarioId !== expected.scenarioId ||
    value.controller !== expected.controller
  ) {
    throw new ApiError(
      "Run response identity did not match the requested scenario and controller."
    );
  }

  const trace = normalizeDetailedRun(value);
  if (
    trace.scenario.id !== expected.scenarioId ||
    trace.controller !== expected.controller
  ) {
    throw new ApiError(
      "Run response scenario did not match the requested demo operation."
    );
  }

  return trace;
}

async function readError(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`.trim();

  try {
    const body = (await response.json()) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const nestedMessage =
      typeof body.error === "object" ? body.error.message : body.error;
    message = body.message ?? nestedMessage ?? message;
  } catch {
    // Preserve the HTTP status when the server does not return JSON.
  }

  return new ApiError(message || "The request failed.", response.status);
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(10_000);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export async function getDemoCatalog(
  signal?: AbortSignal
): Promise<DemoCatalog> {
  const response = await fetch("/api/demo/catalog", {
    headers: { Accept: "application/json" },
    signal: withTimeout(signal)
  });

  if (!response.ok) {
    throw await readError(response);
  }

  return validateCatalog(await response.json());
}

export async function createDemoRun(
  input: CreateDemoRunInput,
  signal?: AbortSignal
): Promise<RunTrace> {
  const response = await fetch("/api/demo/runs", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input),
    signal: withTimeout(signal)
  });

  if (!response.ok) {
    throw await readError(response);
  }

  return validateRunTrace(await response.json(), input);
}
