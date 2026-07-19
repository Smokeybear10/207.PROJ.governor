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
  normalizeProviderUsage,
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
  it("seals an inactive stopped job against later admission", () => {
    const ledger = new ReservationLedger(policy, rateCard);

    expect(ledger.closeStoppedJob()).toMatchObject({
      closed: true,
      completionAccepted: false,
      activeReservation: null
    });
    expect(
      ledger.reserve({
        requestId: "after-stop",
        exactInputTokens: 10,
        requestedMaxOutputTokens: 10,
        minimumUsefulOutputTokens: 1,
        phase: "work",
        binding: requestBinding
      })
    ).toMatchObject({
      admitted: false,
      reason: "JOB_CLOSED"
    });
  });

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

  it("releases a definitively rejected provider request with evidence", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    reserve(ledger, {
      requestId: "provider-rejected",
      exactInputTokens: 10,
      requestedMaxOutputTokens: 5,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });
    dispatch(ledger, "provider-rejected");

    const released = ledger.releaseProviderRejection(
      "provider-rejected",
      {
        httpStatus: 429,
        requestId: "req_rate_limited"
      }
    );

    expect(released).toMatchObject({
      status: "released",
      terminalReason: "provider_rejected",
      providerRejection: {
        httpStatus: 429,
        requestId: "req_rate_limited"
      }
    });
    expect(ledger.getSnapshot()).toMatchObject({
      settledMicroUsd: 0,
      outstandingReservedMicroUsd: 0,
      activeReservation: null,
      responsesStarted: 1
    });
    expect(() =>
      ledger.releaseProviderRejection("provider-rejected", {
        httpStatus: 408
      })
    ).toThrowError(
      expect.objectContaining<Partial<GovernorError>>({
        code: "INVALID_TRANSITION"
      })
    );
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

describe("per-request spending ceilings", () => {
  it("caps the reservation and restores it exactly without storing the ceiling", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    const result = reserve(ledger, {
      requestId: "capped-work",
      exactInputTokens: 10,
      requestedMaxOutputTokens: 100,
      minimumUsefulOutputTokens: 5,
      maximumCostMicroUsd: 32,
      phase: "work"
    });

    expect(result).toMatchObject({
      admitted: true,
      reservation: {
        maxOutputTokens: 10,
        reservedMicroUsd: 32,
        protectedFutureReserveMicroUsd: 30
      }
    });
    dispatch(ledger, "capped-work");
    const saved: unknown = JSON.parse(JSON.stringify(ledger.getState()));
    expect(ReservationLedger.restore(saved, rateCard).getState()).toEqual(ledger.getState());
    settle(ledger, "capped-work", usage({ outputTokens: 10 }));
    expect(ReservationLedger.restore(ledger.getState(), rateCard).getState()).toEqual(ledger.getState());
  });

  it.each([undefined, 70, 100])(
    "preserves the final reserve with a nonbinding ceiling of %s",
    (maximumCostMicroUsd) => {
      const ledger = new ReservationLedger(policy, rateCard);
      expect(reserve(ledger, {
        requestId: "work",
        exactInputTokens: 10,
        requestedMaxOutputTokens: 100,
        minimumUsefulOutputTokens: 5,
        maximumCostMicroUsd,
        phase: "work"
      })).toMatchObject({
        admitted: true,
        reservation: { maxOutputTokens: 29, reservedMicroUsd: 70 }
      });
      expect(ledger.getSnapshot().uncommittedMicroUsd).toBe(30);
    }
  );

  it.each([
    { maximumCostMicroUsd: 11, minimumUsefulOutputTokens: 1, admissibleMaxOutputTokens: 0 },
    { maximumCostMicroUsd: 20, minimumUsefulOutputTokens: 5, admissibleMaxOutputTokens: 4 }
  ])("denies an unaffordable request ceiling without mutation: $maximumCostMicroUsd", (input) => {
    const ledger = new ReservationLedger(policy, rateCard);
    const before = ledger.getState();
    expect(reserve(ledger, {
      requestId: "over-request-limit",
      exactInputTokens: 10,
      requestedMaxOutputTokens: 100,
      minimumUsefulOutputTokens: input.minimumUsefulOutputTokens,
      maximumCostMicroUsd: input.maximumCostMicroUsd,
      phase: "work"
    })).toEqual({
      admitted: false,
      reason: "REQUEST_COST_LIMIT",
      availableMicroUsd: input.maximumCostMicroUsd,
      admissibleMaxOutputTokens: input.admissibleMaxOutputTokens
    });
    expect(ledger.getState()).toEqual(before);
  });

  it("applies the ceiling to final responses without lowering the final output minimum", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    const input = {
      requestId: "final",
      exactInputTokens: 10,
      requestedMaxOutputTokens: 100,
      minimumUsefulOutputTokens: 1,
      phase: "final" as const
    };
    expect(reserve(ledger, { ...input, maximumCostMicroUsd: 29 })).toMatchObject({
      admitted: false,
      reason: "REQUEST_COST_LIMIT",
      admissibleMaxOutputTokens: 8
    });
    expect(reserve(ledger, { ...input, maximumCostMicroUsd: 30 })).toMatchObject({
      admitted: true,
      reservation: {
        maxOutputTokens: 9,
        reservedMicroUsd: 30,
        protectedFutureReserveMicroUsd: 0
      }
    });
  });

  it("keeps existing denial reasons when the request would fail without a ceiling", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    expect(reserve(ledger, {
      requestId: "input-too-large",
      exactInputTokens: 100,
      requestedMaxOutputTokens: 100,
      minimumUsefulOutputTokens: 1,
      maximumCostMicroUsd: 10,
      phase: "work"
    })).toMatchObject({ admitted: false, reason: "INPUT_EXCEEDS_AVAILABLE_BUDGET" });
    expect(reserve(ledger, {
      requestId: "output-too-small",
      exactInputTokens: 10,
      requestedMaxOutputTokens: 8,
      minimumUsefulOutputTokens: 1,
      maximumCostMicroUsd: 10,
      phase: "final"
    })).toMatchObject({ admitted: false, reason: "OUTPUT_BELOW_MINIMUM" });
    expect(ledger.getState().reservations).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid ceiling of %s without mutation",
    (maximumCostMicroUsd) => {
      const ledger = new ReservationLedger(policy, rateCard);
      const before = ledger.getState();
      expect(() => reserve(ledger, {
        requestId: "invalid-ceiling",
        exactInputTokens: 10,
        requestedMaxOutputTokens: 100,
        minimumUsefulOutputTokens: 1,
        maximumCostMicroUsd,
        phase: "work"
      })).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
      expect(ledger.getState()).toEqual(before);
    }
  );
});

describe("reservation ledger persistence", () => {
  function savedCopy(ledger: ReservationLedger): unknown {
    return JSON.parse(JSON.stringify(ledger.getState()));
  }

  function reserveWork(ledger: ReservationLedger, requestId: string) {
    const admission = reserve(ledger, {
      requestId,
      exactInputTokens: 10,
      requestedMaxOutputTokens: 5,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });
    expect(admission.admitted).toBe(true);
  }

  it("restores charged history and provider response deduplication", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    reserveWork(ledger, "released");
    ledger.release("released");
    reserveWork(ledger, "cancelled");
    ledger.cancel("cancelled");
    reserveWork(ledger, "rejected");
    dispatch(ledger, "rejected");
    ledger.releaseProviderRejection("rejected", {
      httpStatus: 429,
      requestId: "provider-rejection"
    });
    reserveWork(ledger, "settled");
    dispatch(ledger, "settled");
    settle(ledger, "settled", usage());

    const restored = ReservationLedger.restore(savedCopy(ledger), rateCard);
    expect(restored.getState()).toEqual(ledger.getState());
    expect(restored.getSnapshot()).toMatchObject({
      responsesStarted: 2,
      settledMicroUsd: 20,
      outstandingReservedMicroUsd: 0
    });
    expect(reserve(restored, {
      requestId: "released",
      exactInputTokens: 1,
      requestedMaxOutputTokens: 1,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    })).toMatchObject({ admitted: false, reason: "DUPLICATE_REQUEST_ID" });
    reserveWork(restored, "duplicate-provider");
    dispatch(restored, "duplicate-provider");
    expect(() => settle(
      restored,
      "duplicate-provider",
      usage(),
      providerEvidence({ id: "resp_settled" })
    )).toThrow("already been settled");
    expect(restored.getSnapshot().settledMicroUsd).toBe(20);
  });

  it.each(["reserved", "in_flight", "ambiguous"] as const)(
    "keeps the full %s reservation unavailable after restart",
    (status) => {
      const ledger = new ReservationLedger(policy, rateCard);
      reserveWork(ledger, "interrupted");
      if (status !== "reserved") {
        dispatch(ledger, "interrupted");
      }
      if (status === "ambiguous") {
        ledger.markAmbiguous("interrupted", "transport_error", {
          usageSource: "provider",
          inputTokens: 10
        });
      }
      const restored = ReservationLedger.restore(savedCopy(ledger), rateCard);
      expect(restored.getState()).toEqual(ledger.getState());
      expect(restored.getSnapshot().outstandingReservedMicroUsd).toBeGreaterThan(0);
      expect(reserve(restored, {
        requestId: "later",
        exactInputTokens: 1,
        requestedMaxOutputTokens: 1,
        minimumUsefulOutputTokens: 1,
        phase: "work"
      })).toMatchObject({ admitted: false, reason: "UNRESOLVED_REQUEST" });
      if (status === "in_flight") {
        restored.markAmbiguous("interrupted", "transport_error");
        expect(restored.getSnapshot().committedMicroUsd).toBe(
          ledger.getSnapshot().committedMicroUsd
        );
      }
    }
  );

  it("retains cancellation evidence and reconciles it once after restart", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    reserveWork(ledger, "cancelled");
    dispatch(ledger, "cancelled");
    ledger.cancel("cancelled", { kind: "unknown", observedUsage: usage() });
    const restored = ReservationLedger.restore(savedCopy(ledger), rateCard);
    restored.cancel("cancelled", {
      kind: "usage",
      usage: usage(),
      evidence: providerEvidence({ status: "cancelled" })
    });
    const settled = ReservationLedger.restore(savedCopy(restored), rateCard);
    expect(settled.getState()).toEqual(restored.getState());
    expect(settled.getReservation("cancelled")).toMatchObject({
      status: "settled",
      terminalReason: "cancelled_with_usage"
    });
    expect(settled.getSnapshot().settledMicroUsd).toBe(20);
  });

  it.each(["timeout", "ambiguity", "cancellation"] as const)(
    "rejects invalid %s observations without mutating durable ledger state",
    (transition) => {
      const ledger = new ReservationLedger(policy, rateCard);
      reserveWork(ledger, "work");
      dispatch(ledger, "work");
      const before = ledger.getState();
      const observation = { usageSource: "provider" as const, inputTokens: -1 };
      expect(() => {
        if (transition === "timeout") ledger.markTimedOut("work", observation);
        else if (transition === "ambiguity") ledger.markAmbiguous("work", "transport_error", observation);
        else ledger.cancel("work", { kind: "unknown", observedUsage: observation });
      }).toThrow(GovernorError);
      expect(ledger.getState()).toEqual(before);
      expect(ReservationLedger.restore(savedCopy(ledger), rateCard).getState()).toEqual(before);
    }
  );

  it.each(["timeout", "ambiguity", "cancellation"] as const)(
    "persists normalized provider usage as a schema-compatible %s observation",
    (transition) => {
      const ledger = new ReservationLedger(policy, rateCard);
      reserveWork(ledger, "work");
      dispatch(ledger, "work");
      const observation = normalizeProviderUsage(usage({
        cachedInputTokens: 2,
        cacheWriteTokens: 1,
        reasoningOutputTokens: 1,
        totalTokens: 15
      }));
      if (transition === "timeout") ledger.markTimedOut("work", observation);
      else if (transition === "ambiguity") ledger.markAmbiguous("work", "transport_error", observation);
      else ledger.cancel("work", { kind: "unknown", observedUsage: observation });

      const restored = ReservationLedger.restore(savedCopy(ledger), rateCard);
      expect(restored.getState()).toEqual(ledger.getState());
      expect(restored.getSnapshot().outstandingReservedMicroUsd).toBeGreaterThan(0);
      expect(restored.getReservation("work")?.ambiguity?.observedUsage).toEqual({
        usageSource: "provider",
        inputTokens: 10,
        cachedInputTokens: 2,
        cacheWriteTokens: 1,
        outputTokens: 5,
        reasoningOutputTokens: 1,
        totalTokens: 15
      });
    }
  );

  it.each([true, false])("retains final validation and accepted=%s closure", (accepted) => {
    const ledger = new ReservationLedger(policy, rateCard);
    expect(reserve(ledger, {
      requestId: "final",
      exactInputTokens: 10,
      requestedMaxOutputTokens: 9,
      minimumUsefulOutputTokens: 9,
      phase: "final"
    }).admitted).toBe(true);
    dispatch(ledger, "final");
    settle(ledger, "final", usage());
    const pending = ReservationLedger.restore(savedCopy(ledger), rateCard);
    expect(pending.getSnapshot()).toMatchObject({
      pendingFinalValidationRequestId: "final",
      closed: false,
      completionAccepted: null
    });
    pending.finalizeFinalResponse("final", accepted);
    const finished = ReservationLedger.restore(savedCopy(pending), rateCard);
    expect(finished.getState()).toEqual(pending.getState());
    expect(finished.getSnapshot()).toMatchObject({
      pendingFinalValidationRequestId: null,
      closed: true,
      completionAccepted: accepted
    });
    expect(reserve(finished, {
      requestId: "later",
      exactInputTokens: 1,
      requestedMaxOutputTokens: 1,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    })).toMatchObject({ admitted: false, reason: "JOB_CLOSED" });
  });

  it("restores a stopped job and an exhausted work response allowance", () => {
    const ledger = new ReservationLedger({ ...policy, maxResponses: 2 }, rateCard);
    reserveWork(ledger, "work");
    dispatch(ledger, "work");
    settle(ledger, "work", usage());
    const restored = ReservationLedger.restore(savedCopy(ledger), rateCard);
    expect(reserve(restored, {
      requestId: "later",
      exactInputTokens: 1,
      requestedMaxOutputTokens: 1,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    })).toMatchObject({ admitted: false, reason: "RESPONSE_LIMIT_REACHED" });
    restored.closeStoppedJob();
    expect(ReservationLedger.restore(savedCopy(restored), rateCard).getSnapshot())
      .toEqual(restored.getSnapshot());
  });

  it("rejects corrupted accounting, reservations, evidence, and versions", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    reserveWork(ledger, "work");
    dispatch(ledger, "work");
    settle(ledger, "work", usage());
    const state = ledger.getState();
    const reservation = state.reservations[0];
    const corruptStates = [
      null,
      { ...state, version: 2 },
      { ...state, ignored: true },
      { ...state, settledMicroUsd: 0 },
      { ...state, responsesStarted: 0 },
      { ...state, activeRequestId: "work" },
      { ...state, completionAccepted: true },
      { ...state, pendingFinalValidationRequestId: "work" },
      { ...state, reservations: [{ ...reservation, reservedMicroUsd: 0 }] },
      { ...state, reservations: [{ ...reservation, settledMicroUsd: 0 }] },
      { ...state, reservations: [{ ...reservation, exactInputTokens: 11 }] },
      { ...state, reservations: [{ ...reservation, requestSha256: undefined }] },
      { ...state, reservations: [{ ...reservation, providerResponse: undefined }] },
      { ...state, reservations: [{ ...reservation, usage: {
        ...reservation.usage,
        uncachedInputTokens: 0
      } }] },
      { ...state, reservations: [reservation, reservation] }
    ];
    for (const corrupted of corruptStates) {
      expect(() => ReservationLedger.restore(corrupted, rateCard)).toThrow(GovernorError);
    }
  });

  it("rejects changed rates even when the rate card version is unchanged", () => {
    const ledger = new ReservationLedger(policy, rateCard);
    const changed = createRateCard({
      ...rateCard,
      rates: { ...rateCard.rates, outputMicroUsdPerMillionTokens: 1_000_000 }
    });
    expect(() => ReservationLedger.restore(savedCopy(ledger), changed)).toThrow(
      "does not match the configured rate card"
    );
  });
});
