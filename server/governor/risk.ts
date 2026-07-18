import {
  assertGovernor,
  requireNonNegativeSafeInteger,
  requirePositiveSafeInteger,
  safeIntegerFromBigInt
} from "./errors.js";

const BASIS_POINTS = 10_000n;

export type RiskBand = "SAFE" | "WATCH" | "AT_RISK";

export interface RiskThresholds {
  readonly watchCommittedBudgetBps: number;
  readonly atRiskCommittedBudgetBps: number;
  readonly watchContextGrowthBps: number;
  readonly atRiskContextGrowthBps: number;
  readonly watchFailedToolCalls: number;
}

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = Object.freeze({
  watchCommittedBudgetBps: 7_000,
  atRiskCommittedBudgetBps: 9_000,
  watchContextGrowthBps: 15_000,
  atRiskContextGrowthBps: 25_000,
  watchFailedToolCalls: 2
});

export interface RiskObservation {
  readonly applicationCeilingMicroUsd: number;
  readonly settledMicroUsd: number;
  readonly outstandingReservationMicroUsd: number;
  readonly protectedFinalAnswerReserveMicroUsd: number;
  readonly minimumCompletionCostMicroUsd: number;
  readonly baselineContextTokens: number;
  readonly currentContextTokens: number;
  readonly equivalentRetryCount: number;
  readonly maxEquivalentRetries: number;
  readonly failedToolCalls: number;
  readonly remainingResponses: number;
}

export type RiskDriverCode =
  | "NO_STATIC_COMPLETION_PATH"
  | "FINAL_RESERVE_PRESSURE"
  | "BUDGET_UTILIZATION"
  | "CONTEXT_GROWTH"
  | "EQUIVALENT_RETRIES"
  | "FAILED_TOOL_CALLS"
  | "NO_RESPONSES_REMAINING";

export interface RiskDriver {
  readonly code: RiskDriverCode;
  readonly severity: "WATCH" | "AT_RISK";
  readonly direction: "increases_cost";
  readonly evidence: string;
}

export interface RiskAssessment {
  readonly band: RiskBand;
  readonly mode: "shadow";
  readonly evaluatedPolicy: "static";
  readonly committedMicroUsd: number;
  readonly remainingUncommittedMicroUsd: number;
  readonly drivers: readonly RiskDriver[];
}

function meetsRatio(
  numerator: number,
  denominator: number,
  thresholdBps: number
): boolean {
  return (
    BigInt(numerator) * BASIS_POINTS >=
    BigInt(denominator) * BigInt(thresholdBps)
  );
}

function validateThresholds(thresholds: RiskThresholds): void {
  requireNonNegativeSafeInteger(
    thresholds.watchCommittedBudgetBps,
    "watchCommittedBudgetBps"
  );
  requireNonNegativeSafeInteger(
    thresholds.atRiskCommittedBudgetBps,
    "atRiskCommittedBudgetBps"
  );
  requirePositiveSafeInteger(
    thresholds.watchContextGrowthBps,
    "watchContextGrowthBps"
  );
  requirePositiveSafeInteger(
    thresholds.atRiskContextGrowthBps,
    "atRiskContextGrowthBps"
  );
  requirePositiveSafeInteger(
    thresholds.watchFailedToolCalls,
    "watchFailedToolCalls"
  );
  assertGovernor(
    thresholds.atRiskCommittedBudgetBps >=
      thresholds.watchCommittedBudgetBps,
    "INVALID_ARGUMENT",
    "The at-risk budget threshold cannot be below the watch threshold."
  );
  assertGovernor(
    thresholds.atRiskContextGrowthBps >=
      thresholds.watchContextGrowthBps,
    "INVALID_ARGUMENT",
    "The at-risk context threshold cannot be below the watch threshold."
  );
}

export function assessRisk(
  observation: RiskObservation,
  thresholds: RiskThresholds = DEFAULT_RISK_THRESHOLDS
): RiskAssessment {
  validateThresholds(thresholds);
  requirePositiveSafeInteger(
    observation.applicationCeilingMicroUsd,
    "applicationCeilingMicroUsd"
  );
  const nonNegativeFields = [
    "settledMicroUsd",
    "outstandingReservationMicroUsd",
    "protectedFinalAnswerReserveMicroUsd",
    "minimumCompletionCostMicroUsd",
    "baselineContextTokens",
    "currentContextTokens",
    "equivalentRetryCount",
    "maxEquivalentRetries",
    "failedToolCalls",
    "remainingResponses"
  ] as const;
  for (const field of nonNegativeFields) {
    requireNonNegativeSafeInteger(observation[field], field);
  }

  const committedMicroUsd = safeIntegerFromBigInt(
    BigInt(observation.settledMicroUsd) +
      BigInt(observation.outstandingReservationMicroUsd),
    "Committed risk-observation cost"
  );
  const remainingUncommittedMicroUsd = Math.max(
    0,
    observation.applicationCeilingMicroUsd - committedMicroUsd
  );
  const drivers: RiskDriver[] = [];

  const addDriver = (
    code: RiskDriverCode,
    severity: "WATCH" | "AT_RISK",
    evidence: string
  ): void => {
    drivers.push(
      Object.freeze({
        code,
        severity,
        direction: "increases_cost" as const,
        evidence
      })
    );
  };

  if (
    observation.minimumCompletionCostMicroUsd >
    remainingUncommittedMicroUsd
  ) {
    addDriver(
      "NO_STATIC_COMPLETION_PATH",
      "AT_RISK",
      `Minimum completion cost ${observation.minimumCompletionCostMicroUsd} exceeds remaining budget ${remainingUncommittedMicroUsd} micro-USD.`
    );
  }
  if (
    observation.protectedFinalAnswerReserveMicroUsd >
    remainingUncommittedMicroUsd
  ) {
    addDriver(
      "FINAL_RESERVE_PRESSURE",
      "AT_RISK",
      `Protected final reserve ${observation.protectedFinalAnswerReserveMicroUsd} exceeds remaining budget ${remainingUncommittedMicroUsd} micro-USD.`
    );
  }

  const budgetAtRisk = meetsRatio(
    committedMicroUsd,
    observation.applicationCeilingMicroUsd,
    thresholds.atRiskCommittedBudgetBps
  );
  const budgetWatch =
    budgetAtRisk ||
    meetsRatio(
      committedMicroUsd,
      observation.applicationCeilingMicroUsd,
      thresholds.watchCommittedBudgetBps
    );
  if (budgetWatch) {
    addDriver(
      "BUDGET_UTILIZATION",
      budgetAtRisk ? "AT_RISK" : "WATCH",
      `Committed cost is ${committedMicroUsd} of ${observation.applicationCeilingMicroUsd} micro-USD.`
    );
  }

  if (observation.baselineContextTokens > 0) {
    const contextAtRisk = meetsRatio(
      observation.currentContextTokens,
      observation.baselineContextTokens,
      thresholds.atRiskContextGrowthBps
    );
    const contextWatch =
      contextAtRisk ||
      meetsRatio(
        observation.currentContextTokens,
        observation.baselineContextTokens,
        thresholds.watchContextGrowthBps
      );
    if (contextWatch) {
      addDriver(
        "CONTEXT_GROWTH",
        contextAtRisk ? "AT_RISK" : "WATCH",
        `Context is ${observation.currentContextTokens} tokens versus a ${observation.baselineContextTokens}-token baseline.`
      );
    }
  }

  if (observation.equivalentRetryCount > 0) {
    const retriesAtRisk =
      observation.equivalentRetryCount >=
      observation.maxEquivalentRetries;
    addDriver(
      "EQUIVALENT_RETRIES",
      retriesAtRisk ? "AT_RISK" : "WATCH",
      `Equivalent retry count is ${observation.equivalentRetryCount} with a limit of ${observation.maxEquivalentRetries}.`
    );
  }
  if (
    observation.failedToolCalls >= thresholds.watchFailedToolCalls
  ) {
    addDriver(
      "FAILED_TOOL_CALLS",
      "WATCH",
      `${observation.failedToolCalls} tool calls have failed.`
    );
  }
  if (
    observation.remainingResponses === 0 &&
    observation.minimumCompletionCostMicroUsd > 0
  ) {
    addDriver(
      "NO_RESPONSES_REMAINING",
      "AT_RISK",
      "No model responses remain while completion work is outstanding."
    );
  }

  const band: RiskBand = drivers.some(
    (driver) => driver.severity === "AT_RISK"
  )
    ? "AT_RISK"
    : drivers.length > 0
      ? "WATCH"
      : "SAFE";

  return Object.freeze({
    band,
    mode: "shadow" as const,
    evaluatedPolicy: "static" as const,
    committedMicroUsd,
    remainingUncommittedMicroUsd,
    drivers: Object.freeze(drivers)
  });
}
