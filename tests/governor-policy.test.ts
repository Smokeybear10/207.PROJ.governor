import { describe, expect, it } from "vitest";
import {
  RetryFingerprintTracker,
  assessRisk,
  canonicalizeRetryArguments,
  type RiskObservation
} from "../server/governor/index.js";

const safeObservation: RiskObservation = {
  applicationCeilingMicroUsd: 1_000,
  settledMicroUsd: 200,
  outstandingReservationMicroUsd: 100,
  protectedFinalAnswerReserveMicroUsd: 150,
  minimumCompletionCostMicroUsd: 200,
  baselineContextTokens: 1_000,
  currentContextTokens: 1_200,
  equivalentRetryCount: 0,
  maxEquivalentRetries: 2,
  failedToolCalls: 0,
  remainingResponses: 3
};

describe("deterministic risk heuristic", () => {
  it("emits SAFE with no invented drivers", () => {
    expect(assessRisk(safeObservation)).toMatchObject({
      band: "SAFE",
      mode: "shadow",
      evaluatedPolicy: "static",
      drivers: []
    });
  });

  it("changes to WATCH exactly at the committed-budget threshold", () => {
    const assessment = assessRisk({
      ...safeObservation,
      settledMicroUsd: 600,
      outstandingReservationMicroUsd: 100
    });
    expect(assessment.band).toBe("WATCH");
    expect(assessment.drivers).toEqual([
      expect.objectContaining({
        code: "BUDGET_UTILIZATION",
        severity: "WATCH"
      })
    ]);
  });

  it("changes to AT_RISK exactly at the high thresholds", () => {
    const budget = assessRisk({
      ...safeObservation,
      settledMicroUsd: 800,
      outstandingReservationMicroUsd: 100
    });
    const context = assessRisk({
      ...safeObservation,
      currentContextTokens: 2_500
    });
    expect(budget.band).toBe("AT_RISK");
    expect(context.band).toBe("AT_RISK");
    expect(context.drivers).toEqual([
      expect.objectContaining({
        code: "CONTEXT_GROWTH",
        severity: "AT_RISK"
      })
    ]);
  });

  it("changes to WATCH exactly at the context-growth threshold", () => {
    const assessment = assessRisk({
      ...safeObservation,
      currentContextTokens: 1_500
    });
    expect(assessment.band).toBe("WATCH");
    expect(assessment.drivers).toEqual([
      expect.objectContaining({
        code: "CONTEXT_GROWTH",
        severity: "WATCH"
      })
    ]);
  });

  it("requires a static completion path to fit the remaining budget", () => {
    const exactFit = assessRisk({
      ...safeObservation,
      settledMicroUsd: 500,
      outstandingReservationMicroUsd: 100,
      minimumCompletionCostMicroUsd: 400
    });
    const missesByOne = assessRisk({
      ...safeObservation,
      settledMicroUsd: 500,
      outstandingReservationMicroUsd: 100,
      minimumCompletionCostMicroUsd: 401
    });

    expect(
      exactFit.drivers.some(
        (driver) => driver.code === "NO_STATIC_COMPLETION_PATH"
      )
    ).toBe(false);
    expect(missesByOne.band).toBe("AT_RISK");
    expect(missesByOne.drivers[0]).toMatchObject({
      code: "NO_STATIC_COMPLETION_PATH",
      severity: "AT_RISK"
    });
  });

  it("reports retries and failed calls as observed drivers", () => {
    const assessment = assessRisk({
      ...safeObservation,
      equivalentRetryCount: 2,
      failedToolCalls: 2
    });
    expect(assessment.band).toBe("AT_RISK");
    expect(assessment.drivers.map((driver) => driver.code)).toEqual([
      "EQUIVALENT_RETRIES",
      "FAILED_TOOL_CALLS"
    ]);
  });
});

describe("duplicate retry fingerprint tracking", () => {
  it("canonicalizes argument object key order", () => {
    expect(
      canonicalizeRetryArguments({ b: 2, a: { y: true, x: 1 } })
    ).toBe('{"a":{"x":1,"y":true},"b":2}');
  });

  it("moves deterministically through retry states and enforces the limit", () => {
    const tracker = new RetryFingerprintTracker(2);
    const first = tracker.observe({
      toolName: "run_tests",
      arguments: { command: "npm test", flags: ["--run"] },
      errorClass: "AssertionError",
      stateRevision: "repo-1"
    });
    const second = tracker.observe({
      toolName: "RUN_TESTS",
      arguments: { flags: ["--run"], command: "npm test" },
      errorClass: "assertionerror",
      stateRevision: "repo-1"
    });
    const third = tracker.observe({
      toolName: "run_tests",
      arguments: { command: "npm test", flags: ["--run"] },
      errorClass: "AssertionError",
      stateRevision: "repo-1"
    });

    expect(first).toMatchObject({
      state: "FIRST_FAILURE",
      equivalentRetryCount: 0,
      retryAllowed: true
    });
    expect(second).toMatchObject({
      state: "EQUIVALENT_RETRY",
      equivalentRetryCount: 1,
      retryAllowed: true
    });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(third).toMatchObject({
      state: "LIMIT_REACHED",
      equivalentRetryCount: 2,
      retryAllowed: false
    });
  });

  it("resets equivalence after material state changes", () => {
    const tracker = new RetryFingerprintTracker(1);
    const first = tracker.observe({
      toolName: "read_file",
      arguments: { path: "src/a.ts" },
      errorClass: "ENOENT",
      stateRevision: "repo-1"
    });
    const changed = tracker.observe({
      toolName: "read_file",
      arguments: { path: "src/a.ts" },
      errorClass: "ENOENT",
      stateRevision: "repo-2"
    });

    expect(changed).toMatchObject({
      state: "MATERIAL_CHANGE",
      equivalentRetryCount: 0,
      retryAllowed: true
    });
    expect(changed.baseFingerprint).toBe(first.baseFingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("does not consume retry budget for transient infrastructure errors", () => {
    const tracker = new RetryFingerprintTracker(1);
    const transientAttempt = {
      toolName: "run_tests",
      arguments: { command: "npm test" },
      errorClass: "ECONNRESET",
      stateRevision: "repo-1",
      transient: true
    } as const;

    expect(tracker.observe(transientAttempt)).toMatchObject({
      state: "TRANSIENT_FAILURE",
      equivalentRetryCount: 0,
      retryAllowed: true
    });
    expect(tracker.observe(transientAttempt)).toMatchObject({
      state: "TRANSIENT_FAILURE",
      equivalentRetryCount: 0,
      retryAllowed: true
    });
  });

  it("allows no equivalent retry when the retry budget is zero", () => {
    const tracker = new RetryFingerprintTracker(0);
    expect(
      tracker.observe({
        toolName: "run_tests",
        arguments: { command: "npm test" },
        errorClass: "AssertionError",
        stateRevision: "repo-1"
      })
    ).toMatchObject({
      state: "FIRST_FAILURE",
      equivalentRetryCount: 0,
      retryAllowed: false
    });
  });
});
