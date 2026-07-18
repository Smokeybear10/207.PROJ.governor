import { describe, expect, it } from "vitest";
import {
  COST_ROUNDING,
  GPT_5_4_MINI_STANDARD_RATE_CARD,
  GovernorError,
  ReservationLedger,
  calculateUsageCost,
  calculateWorstCaseRequestCost,
  createGovernorPolicy,
  createRateCard,
  type ExactInputAdmission,
  type GovernorPolicy,
  type ProviderResponseEvidence,
  type ProviderUsage,
  type RateCard
} from "../server/governor/index.js";

const rateCard: RateCard = createRateCard({
  provider: "test-provider",
  model: "test-model",
  serviceTier: "standard",
  processingRegion: "global",
  version: "test-rates-v1",
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

const policy: GovernorPolicy = createGovernorPolicy({
  applicationCeilingMicroUsd: 100,
  finalAnswerReserveMicroUsd: 30,
  finalAnswerInputTokenLimit: 10,
  minimumFinalOutputTokens: 9,
  maxResponses: 5,
  maxEquivalentRetries: 2,
  rateCardVersion: rateCard.version
});

const requestBinding = {
  contextSha256: "a".repeat(64),
  model: rateCard.model,
  serviceTier: "default" as const,
  processingRegion: rateCard.processingRegion
};

const dispatchBinding = {
  requestSha256: "b".repeat(64)
};

function reserve(
  ledger: ReservationLedger,
  input: Omit<ExactInputAdmission, "binding">
) {
  return ledger.reserve({ ...input, binding: requestBinding });
}

function dispatch(ledger: ReservationLedger, requestId: string) {
  return ledger.dispatch(requestId, dispatchBinding);
}

function providerEvidence(
  overrides: Partial<ProviderResponseEvidence> = {}
): ProviderResponseEvidence {
  return {
    id: "resp_test",
    model: rateCard.model,
    serviceTier: "default",
    status: "completed",
    ...overrides
  };
}

function settle(
  ledger: ReservationLedger,
  requestId: string,
  providerUsage: ProviderUsage,
  evidence = providerEvidence({ id: `resp_${requestId}` })
) {
  return ledger.settle(requestId, providerUsage, evidence);
}

function usage(
  overrides: Partial<ProviderUsage> = {}
): ProviderUsage {
  return {
    inputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 5,
    usageSource: "provider",
    ...overrides
  };
}

describe("versioned rate cards and fixed-point cost math", () => {
  it("pins the official gpt-5.4-mini standard direct API rates", () => {
    expect(GPT_5_4_MINI_STANDARD_RATE_CARD.rates).toEqual({
      uncachedInputMicroUsdPerMillionTokens: 750_000,
      cachedInputMicroUsdPerMillionTokens: 75_000,
      cacheWriteInputMicroUsdPerMillionTokens: 750_000,
      outputMicroUsdPerMillionTokens: 4_500_000
    });
    expect(GPT_5_4_MINI_STANDARD_RATE_CARD.version).toContain(
      "gpt-5.4-mini"
    );
  });

  it("ceil-rounds each aggregate partition without binary floats", () => {
    const cost = calculateUsageCost(
      GPT_5_4_MINI_STANDARD_RATE_CARD,
      usage({
        inputTokens: 3,
        cachedInputTokens: 1,
        cacheWriteTokens: 1,
        outputTokens: 1
      })
    );

    expect(cost.rounding).toBe(COST_ROUNDING);
    expect(cost.usage.uncachedInputTokens).toBe(1);
    expect(cost.charges.map((charge) => charge.microUsd)).toEqual([
      1, 1, 1, 5
    ]);
    expect(cost.totalMicroUsd).toBe(8);
  });

  it("does not add reasoning detail already included in output tokens", () => {
    const withReasoning = calculateUsageCost(
      rateCard,
      usage({
        cachedInputTokens: 4,
        cacheWriteTokens: 2,
        reasoningOutputTokens: 5,
        totalTokens: 15
      })
    );
    const withoutReasoning = calculateUsageCost(
      rateCard,
      usage({ cachedInputTokens: 4, cacheWriteTokens: 2 })
    );

    expect(withReasoning.usage.uncachedInputTokens).toBe(4);
    expect(withReasoning.totalMicroUsd).toBe(
      withoutReasoning.totalMicroUsd
    );
  });

  it("rejects overlapping cached and cache-write partitions", () => {
    expect(() =>
      calculateUsageCost(
        rateCard,
        usage({
          inputTokens: 10,
          cachedInputTokens: 8,
          cacheWriteTokens: 3
        })
      )
    ).toThrowError(
      expect.objectContaining<Partial<GovernorError>>({
        code: "INVALID_USAGE"
      })
    );
  });

  it("includes a conservative partition-rounding bound", () => {
    const worstCase = calculateWorstCaseRequestCost(rateCard, 3, 4);
    expect(worstCase.inputPartitionRoundingBufferMicroUsd).toBe(2);
    expect(worstCase.inputMicroUsd).toBe(5);
    expect(worstCase.outputMicroUsd).toBe(8);
    expect(worstCase.totalMicroUsd).toBe(13);

    const everyPartition = calculateUsageCost(
      rateCard,
      usage({
        inputTokens: 3,
        cachedInputTokens: 1,
        cacheWriteTokens: 1,
        outputTokens: 4
      })
    );
    expect(everyPartition.totalMicroUsd).toBeLessThanOrEqual(
      worstCase.totalMicroUsd
    );
  });

  it("validates and pins a mutable historical rate-card object", () => {
    const mutableRateCard = {
      provider: "test-provider",
      model: "test-model",
      serviceTier: "standard",
      processingRegion: "global",
      version: "test-rates-v1",
      currency: "USD" as const,
      effectiveAt: "2000-01-01T00:00:00.000Z",
      source: "historical test fixture",
      rates: {
        uncachedInputMicroUsdPerMillionTokens: 1_000_000,
        cachedInputMicroUsdPerMillionTokens: 500_000,
        cacheWriteInputMicroUsdPerMillionTokens: 750_000,
        outputMicroUsdPerMillionTokens: 2_000_000
      }
    };
    const ledger = new ReservationLedger(policy, mutableRateCard);

    mutableRateCard.model = "mutated-model";
    mutableRateCard.version = "mutated-version";
    mutableRateCard.rates.outputMicroUsdPerMillionTokens = 9_000_000;

    expect(ledger.getPricingIdentity()).toMatchObject({
      model: "test-model",
      rateCardVersion: "test-rates-v1"
    });
    const admitted = reserve(ledger, {
      requestId: "pinned-card",
      exactInputTokens: 1,
      requestedMaxOutputTokens: 1,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });
    expect(admitted).toMatchObject({
      admitted: true,
      reservation: { reservedMicroUsd: 3 }
    });
    dispatch(ledger, "pinned-card");
    expect(
      settle(
        ledger,
        "pinned-card",
        usage({ inputTokens: 1, outputTokens: 1 })
      ).settledMicroUsd
    ).toBe(3);
  });

  it("rejects invalid plain-object rate cards at construction", () => {
    expect(
      () =>
        new ReservationLedger(policy, {
          ...rateCard,
          rates: {
            ...rateCard.rates,
            outputMicroUsdPerMillionTokens: 0
          }
        })
    ).toThrowError(
      expect.objectContaining<Partial<GovernorError>>({
        code: "INVALID_RATE_CARD"
      })
    );
  });
});

describe("reservation ledger", () => {
  it("protects final reserve and caps work at the exact budget boundary", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    const result = reserve(ledger, {
      requestId: "work-1",
      exactInputTokens: 10,
      requestedMaxOutputTokens: 100,
      minimumUsefulOutputTokens: 5,
      phase: "work"
    });

    expect(result.admitted).toBe(true);
    if (!result.admitted) {
      throw new Error("Expected admission");
    }
    expect(result.reservation.protectedFutureReserveMicroUsd).toBe(30);
    expect(result.reservation.maxOutputTokens).toBe(29);
    expect(result.reservation.reservedMicroUsd).toBe(70);
    expect(ledger.getSnapshot().uncommittedMicroUsd).toBe(30);
  });

  it("denies a request whose minimum useful output is one token over", () => {
    const boundaryPolicy = createGovernorPolicy({
      ...policy,
      applicationCeilingMicroUsd: 20,
      finalAnswerReserveMicroUsd: 10,
      finalAnswerInputTokenLimit: 2,
      minimumFinalOutputTokens: 3
    });
    const ledger = new ReservationLedger(boundaryPolicy, rateCard);
    const denied = reserve(ledger, {
      requestId: "too-large",
      exactInputTokens: 2,
      requestedMaxOutputTokens: 10,
      minimumUsefulOutputTokens: 4,
      phase: "work"
    });

    expect(denied).toEqual({
      admitted: false,
      reason: "OUTPUT_BELOW_MINIMUM",
      availableMicroUsd: 10,
      admissibleMaxOutputTokens: 3
    });
  });

  it("settles cached usage and makes the protected reserve available to final", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    const work = reserve(ledger, {
      requestId: "work",
      exactInputTokens: 10,
      requestedMaxOutputTokens: 10,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });
    expect(work.admitted).toBe(true);
    dispatch(ledger, "work");
    const settled = settle(ledger, 
      "work",
      usage({
        cachedInputTokens: 4,
        cacheWriteTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 3
      })
    );

    expect(settled.settledMicroUsd).toBe(18);
    expect(settled.usage?.uncachedInputTokens).toBe(4);
    const final = reserve(ledger, {
      requestId: "final",
      exactInputTokens: 4,
      requestedMaxOutputTokens: 100,
      minimumUsefulOutputTokens: 1,
      phase: "final"
    });
    expect(final.admitted).toBe(true);
    if (final.admitted) {
      expect(final.reservation.protectedFutureReserveMicroUsd).toBe(0);
      expect(final.reservation.reservedMicroUsd).toBeLessThanOrEqual(82);
    }
  });

  it("atomically rejects a second reservation while one is unresolved", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    expect(
      reserve(ledger, {
        requestId: "first",
        exactInputTokens: 1,
        requestedMaxOutputTokens: 2,
        minimumUsefulOutputTokens: 1,
        phase: "work"
      }).admitted
    ).toBe(true);

    expect(
      reserve(ledger, {
        requestId: "racing-second",
        exactInputTokens: 1,
        requestedMaxOutputTokens: 2,
        minimumUsefulOutputTokens: 1,
        phase: "work"
      })
    ).toMatchObject({
      admitted: false,
      reason: "UNRESOLVED_REQUEST"
    });
  });

  it("retains timeout reservations until provider reconciliation", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    reserve(ledger, {
      requestId: "timed-out",
      exactInputTokens: 10,
      requestedMaxOutputTokens: 5,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });
    dispatch(ledger, "timed-out");
    const ambiguous = ledger.markTimedOut("timed-out", {
      usageSource: "provider",
      outputTokens: 2
    });

    expect(ambiguous.status).toBe("ambiguous");
    expect(ledger.getSnapshot().outstandingReservedMicroUsd).toBe(
      ambiguous.reservedMicroUsd
    );
    expect(
      reserve(ledger, {
        requestId: "blocked",
        exactInputTokens: 1,
        requestedMaxOutputTokens: 1,
        minimumUsefulOutputTokens: 1,
        phase: "work"
      })
    ).toMatchObject({
      admitted: false,
      reason: "UNRESOLVED_REQUEST"
    });

    const reconciled = ledger.reconcile("timed-out", {
      kind: "usage",
      usage: usage({ outputTokens: 2 }),
      evidence: providerEvidence()
    });
    expect(reconciled.status).toBe("settled");
    expect(ledger.getSnapshot().outstandingReservedMicroUsd).toBe(0);
  });

  it("only releases before dispatch and retains unsupported cancellation", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    reserve(ledger, {
      requestId: "not-sent",
      exactInputTokens: 2,
      requestedMaxOutputTokens: 2,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });
    const released = ledger.release("not-sent");
    expect(released).toMatchObject({
      status: "released",
      terminalReason: "released_before_dispatch"
    });
    expect(ledger.getSnapshot().responsesStarted).toBe(0);

    reserve(ledger, {
      requestId: "cancelled-before-send",
      exactInputTokens: 2,
      requestedMaxOutputTokens: 2,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });
    expect(ledger.cancel("cancelled-before-send")).toMatchObject({
      status: "released",
      terminalReason: "cancelled_before_dispatch"
    });

    reserve(ledger, {
      requestId: "cancelled",
      exactInputTokens: 2,
      requestedMaxOutputTokens: 2,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });
    dispatch(ledger, "cancelled");
    const cancelled = ledger.cancel("cancelled");
    expect(cancelled.status).toBe("ambiguous");
    expect(ledger.getSnapshot().outstandingReservedMicroUsd).toBeGreaterThan(
      0
    );

    expect(() =>
      ledger.cancel("cancelled", { kind: "no_charge" } as never)
    ).toThrowError(
      expect.objectContaining<Partial<GovernorError>>({
        code: "INVALID_ARGUMENT"
      })
    );
    expect(() =>
      ledger.reconcile("cancelled", { kind: "no_charge" } as never)
    ).toThrowError(
      expect.objectContaining<Partial<GovernorError>>({
        code: "INVALID_ARGUMENT"
      })
    );
    expect(ledger.getSnapshot()).toMatchObject({
      outstandingReservedMicroUsd: cancelled.reservedMicroUsd,
      activeReservation: {
        requestId: "cancelled",
        status: "ambiguous",
        ambiguity: { reason: "cancellation" }
      }
    });
  });

  it("rejects a settled provider response ID replay across requests", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    reserve(ledger, {
      requestId: "original",
      exactInputTokens: 1,
      requestedMaxOutputTokens: 1,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });
    dispatch(ledger, "original");
    settle(
      ledger,
      "original",
      usage({ inputTokens: 1, outputTokens: 1 }),
      providerEvidence({ id: "resp_replayed" })
    );

    reserve(ledger, {
      requestId: "replay-target",
      exactInputTokens: 1,
      requestedMaxOutputTokens: 1,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });
    dispatch(ledger, "replay-target");
    expect(() =>
      settle(
        ledger,
        "replay-target",
        usage({ inputTokens: 1, outputTokens: 1 }),
        providerEvidence({ id: "resp_replayed" })
      )
    ).toThrowError(
      expect.objectContaining<Partial<GovernorError>>({
        code: "INVALID_USAGE"
      })
    );
    expect(ledger.getSnapshot()).toMatchObject({
      settledMicroUsd: 3,
      activeReservation: {
        requestId: "replay-target",
        status: "in_flight"
      }
    });
  });

  it("rejects provider model prefix collisions", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    reserve(ledger, {
      requestId: "model-alias",
      exactInputTokens: 1,
      requestedMaxOutputTokens: 1,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });
    dispatch(ledger, "model-alias");

    expect(() =>
      settle(
        ledger,
        "model-alias",
        usage({ inputTokens: 1, outputTokens: 1 }),
        providerEvidence({ model: `${rateCard.model}-snapshot` })
      )
    ).toThrowError(
      expect.objectContaining<Partial<GovernorError>>({
        code: "RATE_CARD_MISMATCH"
      })
    );
    expect(ledger.getSnapshot()).toMatchObject({
      settledMicroUsd: 0,
      activeReservation: {
        requestId: "model-alias",
        status: "in_flight"
      }
    });
  });

  it("rejects settlement that differs from exact preflight input", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    reserve(ledger, {
      requestId: "mismatch",
      exactInputTokens: 10,
      requestedMaxOutputTokens: 5,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });
    dispatch(ledger, "mismatch");

    expect(() =>
      settle(ledger, "mismatch", usage({ inputTokens: 11 }))
    ).toThrowError(
      expect.objectContaining<Partial<GovernorError>>({
        code: "RESERVATION_BREACH"
      })
    );
    expect(ledger.getSnapshot().activeReservation?.status).toBe(
      "in_flight"
    );
  });

  it("rejects provider output beyond the reserved cap", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    const admitted = reserve(ledger, {
      requestId: "output-breach",
      exactInputTokens: 1,
      requestedMaxOutputTokens: 2,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });
    expect(admitted.admitted).toBe(true);
    dispatch(ledger, "output-breach");

    expect(() =>
      settle(ledger, 
        "output-breach",
        usage({
          inputTokens: 1,
          outputTokens: 3
        })
      )
    ).toThrowError(
      expect.objectContaining<Partial<GovernorError>>({
        code: "RESERVATION_BREACH"
      })
    );
  });

  it("blocks new work until a settled final response is validated", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    reserve(ledger, {
      requestId: "final-only",
      exactInputTokens: 1,
      requestedMaxOutputTokens: policy.minimumFinalOutputTokens,
      minimumUsefulOutputTokens: 1,
      phase: "final"
    });
    dispatch(ledger, "final-only");
    settle(ledger, 
      "final-only",
      usage({
        inputTokens: 1,
        outputTokens: 1
      })
    );

    expect(ledger.getSnapshot()).toMatchObject({
      closed: false,
      pendingFinalValidationRequestId: "final-only"
    });
    expect(
      reserve(ledger, {
        requestId: "after-final",
        exactInputTokens: 1,
        requestedMaxOutputTokens: 1,
        minimumUsefulOutputTokens: 1,
        phase: "work"
      })
    ).toMatchObject({
      admitted: false,
      reason: "UNRESOLVED_REQUEST"
    });

    const finalized = ledger.finalizeFinalResponse("final-only", true);
    expect(finalized.applicationAccepted).toBe(true);
    expect(ledger.getSnapshot()).toMatchObject({
      closed: true,
      completionAccepted: true
    });
    expect(
      reserve(ledger, {
        requestId: "after-accepted-final",
        exactInputTokens: 1,
        requestedMaxOutputTokens: 1,
        minimumUsefulOutputTokens: 1,
        phase: "work"
      })
    ).toMatchObject({
      admitted: false,
      reason: "JOB_CLOSED"
    });
  });

  it("rejects a final context that exceeds the funded token bound", () => {
    const ledger = new ReservationLedger(policy, rateCard);

    expect(
      reserve(ledger, {
        requestId: "oversized-final",
        exactInputTokens: policy.finalAnswerInputTokenLimit + 1,
        requestedMaxOutputTokens: 20,
        minimumUsefulOutputTokens: 1,
        phase: "final"
      })
    ).toMatchObject({
      admitted: false,
      reason: "FINAL_INPUT_LIMIT_EXCEEDED"
    });
  });

  it("rejects a policy whose final reserve cannot fund its token bound", () => {
    const underfunded = createGovernorPolicy({
      ...policy,
      finalAnswerReserveMicroUsd: 29
    });

    expect(() => new ReservationLedger(underfunded, rateCard)).toThrowError(
      expect.objectContaining<Partial<GovernorError>>({
        code: "INVALID_ARGUMENT"
      })
    );
  });

  it("reserves maxResponses=1 for a final-only response", () => {
    const oneResponsePolicy = createGovernorPolicy({
      ...policy,
      maxResponses: 1
    });
    const ledger = new ReservationLedger(oneResponsePolicy, rateCard);
    expect(
      reserve(ledger, {
        requestId: "work-without-slot",
        exactInputTokens: 1,
        requestedMaxOutputTokens: 1,
        minimumUsefulOutputTokens: 1,
        phase: "work"
      })
    ).toMatchObject({
      admitted: false,
      reason: "RESPONSE_LIMIT_REACHED"
    });

    expect(
      reserve(ledger, {
        requestId: "only-final",
        exactInputTokens: 1,
        requestedMaxOutputTokens: policy.minimumFinalOutputTokens,
        minimumUsefulOutputTokens: 1,
        phase: "final"
      }).admitted
    ).toBe(true);
    dispatch(ledger, "only-final");
    settle(
      ledger,
      "only-final",
      usage({ inputTokens: 1, outputTokens: 1 })
    );
    expect(ledger.getSnapshot().responsesStarted).toBe(1);
  });

  it("allows N-1 work responses followed by the final response", () => {
    const threeResponsePolicy = createGovernorPolicy({
      ...policy,
      maxResponses: 3
    });
    const ledger = new ReservationLedger(threeResponsePolicy, rateCard);

    for (const requestId of ["work-1", "work-2"]) {
      expect(
        reserve(ledger, {
          requestId,
          exactInputTokens: 1,
          requestedMaxOutputTokens: 1,
          minimumUsefulOutputTokens: 1,
          phase: "work"
        }).admitted
      ).toBe(true);
      dispatch(ledger, requestId);
      settle(
        ledger,
        requestId,
        usage({ inputTokens: 1, outputTokens: 1 })
      );
    }

    expect(
      reserve(ledger, {
        requestId: "work-3",
        exactInputTokens: 1,
        requestedMaxOutputTokens: 1,
        minimumUsefulOutputTokens: 1,
        phase: "work"
      })
    ).toMatchObject({
      admitted: false,
      reason: "RESPONSE_LIMIT_REACHED"
    });
    expect(
      reserve(ledger, {
        requestId: "final-3",
        exactInputTokens: 1,
        requestedMaxOutputTokens: policy.minimumFinalOutputTokens,
        minimumUsefulOutputTokens: 1,
        phase: "final"
      }).admitted
    ).toBe(true);
    dispatch(ledger, "final-3");
    settle(
      ledger,
      "final-3",
      usage({ inputTokens: 1, outputTokens: 1 })
    );
    expect(ledger.getSnapshot().responsesStarted).toBe(3);
  });
});
