import { describe, expect, it } from "vitest";
import {
  ReservationLedger,
  RetryFingerprintTracker,
  assessLedgerRisk,
  createGovernorPolicy,
  createRateCard
} from "../server/governor/index.js";

const rateCard = createRateCard({
  provider: "test-provider",
  model: "test-model",
  serviceTier: "standard",
  processingRegion: "global",
  version: "governor-core-test-v1",
  currency: "USD",
  effectiveAt: "2026-07-18T00:00:00.000Z",
  source: "test fixture",
  rates: {
    uncachedInputMicroUsdPerMillionTokens: 1_000_000,
    cachedInputMicroUsdPerMillionTokens: 500_000,
    cacheWriteInputMicroUsdPerMillionTokens: 750_000,
    outputMicroUsdPerMillionTokens: 2_000_000
  }
});

const policy = createGovernorPolicy({
  applicationCeilingMicroUsd: 100,
  finalAnswerReserveMicroUsd: 30,
  finalAnswerInputTokenLimit: 10,
  minimumFinalOutputTokens: 9,
  maxResponses: 3,
  maxEquivalentRetries: 2,
  rateCardVersion: rateCard.version
});

const binding = {
  contextSha256: "a".repeat(64),
  model: rateCard.model,
  serviceTier: "default" as const,
  processingRegion: rateCard.processingRegion
};

const safeSignals = {
  minimumCompletionCostMicroUsd: 20,
  baselineContextTokens: 1_000,
  currentContextTokens: 1_000,
  equivalentRetryCount: 0,
  failedToolCalls: 0
};

describe("connected governor core", () => {
  it("derives risk directly from reserved ledger state", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    const admission = ledger.reserve({
      requestId: "work-1",
      exactInputTokens: 10,
      requestedMaxOutputTokens: 100,
      minimumUsefulOutputTokens: 1,
      phase: "work",
      binding
    });

    expect(admission).toMatchObject({
      admitted: true,
      reservation: {
        reservedMicroUsd: 70,
        protectedFutureReserveMicroUsd: 30
      }
    });
    expect(
      assessLedgerRisk(ledger.getSnapshot(), safeSignals)
    ).toMatchObject({
      band: "WATCH",
      committedMicroUsd: 70,
      remainingUncommittedMicroUsd: 30,
      drivers: [
        {
          code: "BUDGET_UTILIZATION",
          severity: "WATCH"
        }
      ]
    });
  });

  it("connects retry observations to the policy risk limit", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    const tracker = new RetryFingerprintTracker(
      policy.maxEquivalentRetries
    );
    const attempt = {
      toolName: "run_tests",
      arguments: { command: "npm test" },
      errorClass: "AssertionError",
      stateRevision: "repo-1"
    } as const;

    tracker.observe(attempt);
    const retry = tracker.observe(attempt);
    const assessment = assessLedgerRisk(ledger.getSnapshot(), {
      ...safeSignals,
      equivalentRetryCount: retry.equivalentRetryCount
    });

    expect(assessment).toMatchObject({
      band: "WATCH",
      drivers: [
        {
          code: "EQUIVALENT_RETRIES",
          severity: "WATCH"
        }
      ]
    });
  });

  it("does not double-count the final reserve during a final request", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    const admission = ledger.reserve({
      requestId: "final-1",
      exactInputTokens: 10,
      requestedMaxOutputTokens: 100,
      minimumUsefulOutputTokens: 1,
      phase: "final",
      binding
    });

    expect(admission).toMatchObject({
      admitted: true,
      reservation: {
        reservedMicroUsd: 100,
        protectedFutureReserveMicroUsd: 0
      }
    });
    const assessment = assessLedgerRisk(ledger.getSnapshot(), {
      ...safeSignals,
      minimumCompletionCostMicroUsd: 0
    });

    expect(
      assessment.drivers.some(
        (driver) => driver.code === "FINAL_RESERVE_PRESSURE"
      )
    ).toBe(false);
  });

  it("reports no future execution risk after the ledger closes", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    const admission = ledger.reserve({
      requestId: "final-closed",
      exactInputTokens: 10,
      requestedMaxOutputTokens: 100,
      minimumUsefulOutputTokens: 1,
      phase: "final",
      binding
    });
    expect(admission.admitted).toBe(true);

    ledger.dispatch("final-closed", {
      requestSha256: "b".repeat(64)
    });
    ledger.settle(
      "final-closed",
      {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 9,
        usageSource: "provider"
      },
      {
        id: "response-final-closed",
        model: rateCard.model,
        serviceTier: "default",
        status: "completed"
      }
    );
    ledger.finalizeFinalResponse("final-closed", true);

    expect(
      assessLedgerRisk(ledger.getSnapshot(), {
        minimumCompletionCostMicroUsd: 100,
        baselineContextTokens: 1,
        currentContextTokens: 10_000,
        equivalentRetryCount: 10,
        failedToolCalls: 10
      })
    ).toMatchObject({
      band: "SAFE",
      drivers: []
    });
  });
});
