import { ApiError } from "../errors.js";

export const DEMO_MODE = "DEMO" as const;

export const DEMO_TRUTH_LABEL =
  "DEMO: deterministic synthetic simulation; no external model or provider API calls were made." as const;

export const DEMO_RATE_CARD_VERSION =
  "openai-gpt-5.4-mini-standard-2026-07-18" as const;

export const DEMO_CONTROLLERS = [
  "hard_cap",
  "static",
  "shadow"
] as const;

export type DemoController = (typeof DEMO_CONTROLLERS)[number];

export const DEMO_SCENARIO_IDS = [
  "large-failing-log",
  "clean-small-diff",
  "repeated-unchanged-retry"
] as const;

export type DemoScenarioId = (typeof DEMO_SCENARIO_IDS)[number];

export type DemoMode = typeof DEMO_MODE;
export type DemoTruthLabel = typeof DEMO_TRUTH_LABEL;
export type RiskBand = "SAFE" | "WATCH" | "AT_RISK";
export type RunStatus = "COMPLETED" | "POLICY_STOPPED";
export type QualityGateStatus = "PASSED" | "FAILED";

export interface DemoProvenance {
  readonly origin: "SYNTHETIC_DETERMINISTIC_FIXTURE";
  readonly governorCore: "GOVERNOR_CORE_ENFORCED";
  readonly externalApiCalls: 0;
  readonly usageSource: "SIMULATED";
  readonly costBasis: "SIMULATED_LIST_PRICE_MICRO_USD";
}

export interface DemoRateCard {
  readonly version: typeof DEMO_RATE_CARD_VERSION;
  readonly provider: "openai";
  readonly model: "gpt-5.4-mini";
  readonly serviceTier: "standard";
  readonly processingRegion: "global";
  readonly currency: "USD";
  readonly unit: "USD_PER_MILLION_TOKENS";
  readonly uncachedInputUsdPerMillionTokens: number;
  readonly cachedInputUsdPerMillionTokens: number;
  readonly outputUsdPerMillionTokens: number;
  readonly uncachedInputMicroUsdPerMillionTokens: number;
  readonly cachedInputMicroUsdPerMillionTokens: number;
  readonly outputMicroUsdPerMillionTokens: number;
  readonly rounding: "CEIL_EACH_AGGREGATE_CHARGE";
  readonly source: "PINNED_STANDARD_PRICING_FOR_DEMO";
  readonly disclosure: string;
}

export interface DemoTaskPolicy {
  readonly id: "routine-pr-review-v1";
  readonly name: "Routine PR Review";
  readonly applicationCeilingMicroUsd: number;
  readonly protectedFinalReserveMicroUsd: number;
  readonly finalAnswerInputTokenLimit: number;
  readonly minimumFinalOutputTokens: number;
  readonly maxResponses: number;
  readonly maxEquivalentRetries: number;
  readonly rateCardVersion: typeof DEMO_RATE_CARD_VERSION;
}

export interface DemoScenario {
  readonly id: DemoScenarioId;
  readonly title: string;
  readonly summary: string;
  readonly spotlight: boolean;
  readonly repository: "token-governor/pr-review-fixtures";
  readonly pullRequestNumber: number;
  readonly changedFiles: number;
  readonly changedLines: number;
  readonly initialContextTokens: number;
  readonly expectedOutcome: "FINDINGS" | "CLEAN";
  readonly taskPolicy: DemoTaskPolicy;
  readonly signals: readonly string[];
}

export interface DemoQualityGate {
  readonly id: "pr-review-quality-v1";
  readonly minimumScore: 85;
  readonly requireStructuredOutput: true;
  readonly requireEveryCriticalIssue: true;
  readonly maximumCriticalFalsePositives: 0;
  readonly requireEveryAssignedRun: true;
}

export interface BenchmarkComparisonRow {
  readonly controller: DemoController;
  readonly assignedRuns: number;
  readonly completedRuns: number;
  readonly qualityPassedRuns: number;
  readonly criticalMisses: number;
  readonly totalSettledMicroUsd: number;
  readonly qualityGatePassed: boolean;
  readonly eligibleForCostComparison: boolean;
  readonly costDeltaVsStaticMicroUsd: number | null;
}

export interface DemoBenchmark {
  readonly id: "pr-review-demo-benchmark-v1";
  readonly title: "Deterministic PR review demo benchmark";
  readonly mode: DemoMode;
  readonly truthLabel: DemoTruthLabel;
  readonly provenance: DemoProvenance;
  readonly rateCard: DemoRateCard;
  readonly scenarioCount: number;
  readonly controllers: readonly DemoController[];
  readonly qualityGate: DemoQualityGate;
  readonly comparisonRows: readonly BenchmarkComparisonRow[];
  readonly conclusion:
    | "STATIC_GUARDRAILS_DEMONSTRATED"
    | "SHADOW_INCREMENTAL_VALUE_NOT_ESTABLISHED";
  readonly disclosure: string;
}

export interface DemoCatalog {
  readonly scenarios: readonly DemoScenario[];
  readonly benchmark: DemoBenchmark;
}

export interface TokenMetricsSnapshot {
  /**
   * Cumulative simulated input tokens admitted through this event.
   */
  readonly inputTokens: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  /**
   * Cumulative simulated output tokens settled through this event.
   */
  readonly outputTokens: number;
  /**
   * Tokens currently carried into the next model context.
   */
  readonly contextTokens: number;
}

export interface EventMetricsSnapshot extends TokenMetricsSnapshot {
  readonly settledMicroUsd: number;
  readonly reservedMicroUsd: number;
  readonly finalReserveMicroUsd: number;
  readonly remainingMicroUsd: number;
}

export interface ObservedRiskDriver {
  readonly id: string;
  readonly direction: "INCREASES_RISK" | "DECREASES_RISK";
  readonly label: string;
  readonly evidence: string;
}

export interface EventRiskSnapshot {
  readonly band: RiskBand;
  readonly engine: "GOVERNOR_CORE";
  readonly mode: "ENFORCED" | "SHADOW";
  readonly source:
    | "DETERMINISTIC_BOUND"
    | "STATIC_RULES"
    | "SHADOW_FORECAST";
  readonly observedDrivers: readonly ObservedRiskDriver[];
}

export interface DemoRequestAdmission {
  readonly requestId: string;
  readonly phase: "work" | "final";
  readonly exactInputTokens: number;
  readonly requestedMaxOutputTokens: number;
  readonly minimumUsefulOutputTokens: number;
  readonly admittedMaxOutputTokens: number;
}

export interface DemoArtifact {
  readonly id: string;
  readonly kind: "REDUCED_TEST_LOG";
  readonly mediaType: "text/plain";
  readonly checksumSha256: string;
  readonly originalTokens: number;
  readonly retainedTokens: number;
  readonly retainedEvidence: readonly string[];
}

export interface SyntheticCostReceipt {
  readonly id: string;
  readonly kind: "SYNTHETIC_COST_RECEIPT";
  readonly requestNumber: number;
  readonly rateCardVersion: typeof DEMO_RATE_CARD_VERSION;
  readonly rounding: "CEIL_EACH_AGGREGATE_CHARGE";
  readonly usage: {
    readonly uncachedInputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
  };
  readonly charges: {
    readonly uncachedInputMicroUsd: number;
    readonly cachedInputMicroUsd: number;
    readonly outputMicroUsd: number;
  };
  readonly totalMicroUsd: number;
  readonly disclosure: "Synthetic demo calculation; not measured API usage.";
}

export type InterventionActionKind =
  | "REDUCE_TEST_LOG"
  | "SUPPRESS_DUPLICATE_OUTPUT"
  | "REJECT_UNCHANGED_RETRY"
  | "PRESERVE_COMPLETION_BUDGET"
  | "STOP_BEFORE_OVERRUN";

export interface InterventionEffect {
  readonly contextTokensRemoved: number;
  readonly retryPrevented: boolean;
  readonly reserveProtectedMicroUsd: number;
  readonly artifact?: DemoArtifact;
}

export interface InterventionAction {
  readonly id: string;
  readonly kind: InterventionActionKind;
  readonly source: "HARD_CAP" | "STATIC_GUARDRAIL" | "SHADOW_FORECAST";
  readonly execution: "APPLIED" | "RECOMMENDED";
  readonly summary: string;
  readonly reason: string;
  readonly effect: InterventionEffect;
}

export type RunEventType =
  | "RUN_STARTED"
  | "REQUEST_ADMITTED"
  | "RESPONSE_SETTLED"
  | "TOOL_RESULT"
  | "RISK_EVALUATED"
  | "INTERVENTION"
  | "RETRY_REJECTED"
  | "QUALITY_EVALUATED"
  | "RUN_COMPLETED"
  | "RUN_STOPPED";

export interface RunEvent {
  readonly id: string;
  readonly sequence: number;
  readonly offsetMs: number;
  readonly type: RunEventType;
  readonly title: string;
  readonly detail: string;
  readonly metrics: EventMetricsSnapshot;
  readonly risk: EventRiskSnapshot;
  readonly requestAdmission?: DemoRequestAdmission;
  readonly action?: InterventionAction;
  readonly syntheticReceipt?: SyntheticCostReceipt;
}

export interface QualityResult {
  readonly gate: QualityGateStatus;
  readonly score: number;
  readonly structuredOutputValid: boolean;
  readonly seededIssuesExpected: number;
  readonly seededIssuesFound: number;
  readonly criticalIssuesExpected: number;
  readonly criticalIssuesFound: number;
  readonly criticalFalsePositives: number;
  readonly summary: string;
}

export interface ControllerComparisonRow {
  readonly controller: DemoController;
  readonly selected: boolean;
  readonly status: RunStatus;
  readonly settledMicroUsd: number;
  readonly applicationCeilingMicroUsd: number;
  readonly withinCeiling: boolean;
  readonly qualityGate: QualityGateStatus;
  readonly qualityScore: number;
  readonly criticalMisses: number;
  readonly eligibleForCostComparison: boolean;
  readonly costDeltaVsStaticMicroUsd: number | null;
  readonly appliedInterventions: number;
}

export interface RunFinalSummary {
  readonly status: RunStatus;
  readonly headline: string;
  readonly detail: string;
  readonly settledMicroUsd: number;
  readonly applicationCeilingMicroUsd: number;
  readonly unusedMicroUsd: number;
  readonly completedWithinPolicy: boolean;
  readonly qualityGatePassed: boolean;
  readonly appliedInterventions: readonly InterventionActionKind[];
  readonly comparisonDisclosure: string;
}

export interface RunTrace {
  readonly version: 1;
  readonly id: string;
  readonly mode: DemoMode;
  readonly truthLabel: DemoTruthLabel;
  readonly provenance: DemoProvenance;
  readonly rateCard: DemoRateCard;
  readonly scenarioId: DemoScenarioId;
  readonly scenario: DemoScenario;
  readonly controller: DemoController;
  readonly taskPolicy: DemoTaskPolicy;
  readonly status: RunStatus;
  readonly quality: QualityResult;
  readonly events: readonly RunEvent[];
  readonly syntheticReceipts: readonly SyntheticCostReceipt[];
  readonly finalSummary: RunFinalSummary;
  readonly comparisonRows: readonly ControllerComparisonRow[];
}

export interface CreateDemoRunInput {
  readonly scenarioId: DemoScenarioId;
  readonly controller: DemoController;
}

export type DemoInputErrorCode =
  | "INVALID_DEMO_INPUT"
  | "UNKNOWN_SCENARIO"
  | "UNKNOWN_CONTROLLER";

export class DemoInputError extends ApiError {
  declare readonly code: DemoInputErrorCode;

  constructor(code: DemoInputErrorCode, message: string) {
    super(code, message, 400);
    this.name = "DemoInputError";
  }
}
