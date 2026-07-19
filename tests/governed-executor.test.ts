import { describe, expect, it, vi } from "vitest";
import {
  ReservationLedger,
  createGovernorPolicy,
  createRateCard
} from "../server/governor/index.js";
import type {
  GovernedResponseRequest,
  ResponseContext,
  TerminalResponse
} from "../server/openai/index.js";
import { OpenAiApiError } from "../server/openai/index.js";
import {
  executeGovernedResponse,
  type ResponsesProvider
} from "../server/runtime/index.js";

const rateCard = createRateCard({
  provider: "test",
  model: "test-model",
  serviceTier: "standard",
  processingRegion: "global",
  version: "test-v1",
  currency: "USD",
  effectiveAt: "2026-07-18T00:00:00.000Z",
  source: "test",
  rates: {
    uncachedInputMicroUsdPerMillionTokens: 1_000_000,
    cachedInputMicroUsdPerMillionTokens: 500_000,
    cacheWriteInputMicroUsdPerMillionTokens: 1_000_000,
    outputMicroUsdPerMillionTokens: 2_000_000
  }
});

const context: ResponseContext = {
  model: "test-model",
  instructions: "Review the change.",
  input: "diff --git a/a.ts b/a.ts",
  tools: [
    {
      type: "function",
      name: "read_file",
      parameters: { type: "object", properties: {} }
    }
  ]
};

function createLedger(applicationCeilingMicroUsd = 100): ReservationLedger {
  return new ReservationLedger(
    createGovernorPolicy({
      applicationCeilingMicroUsd,
      finalAnswerReserveMicroUsd: 30,
      finalAnswerInputTokenLimit: 10,
      minimumFinalOutputTokens: 9,
      maxResponses: 4,
      maxEquivalentRetries: 1,
      rateCardVersion: rateCard.version
    }),
    rateCard
  );
}

function terminalResponse(
  overrides: Partial<TerminalResponse> = {}
): TerminalResponse {
  return {
    id: "resp_test",
    model: "test-model",
    serviceTier: "default",
    status: "completed",
    output: [],
    usage: {
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 2,
      totalTokens: 15
    },
    ...overrides
  };
}

function providerFor(
  create: (
    request: GovernedResponseRequest
  ) => Promise<TerminalResponse> = async () => terminalResponse()
): {
  provider: ResponsesProvider;
  created: GovernedResponseRequest[];
  counts: { preflight: number; create: number };
} {
  const created: GovernedResponseRequest[] = [];
  const counts = { preflight: 0, create: 0 };
  return {
    created,
    counts,
    provider: {
      async countInput(receivedContext) {
        counts.preflight += 1;
        expect(receivedContext).toEqual({
          ...context,
          service_tier: "default"
        });
        return 10;
      },
      async createResponse(request) {
        counts.create += 1;
        created.push(request);
        return create(request);
      }
    }
  };
}

describe("executeGovernedResponse", () => {
  it("preflights, reserves, caps, dispatches, and settles one response", async () => {
    const ledger = createLedger();
    const fake = providerFor();

    const result = await executeGovernedResponse({
      ledger,
      provider: fake.provider,
      requestId: "step-1",
      context,
      requestedMaxOutputTokens: 100,
      minimumUsefulOutputTokens: 5,
      phase: "work"
    });

    expect(result.status).toBe("settled");
    if (result.status !== "settled") {
      throw new Error("Expected a settled governed response.");
    }
    expect(fake.counts).toEqual({ preflight: 1, create: 1 });
    expect(fake.created[0]).toMatchObject({
      ...context,
      service_tier: "default",
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 29,
      parallel_tool_calls: false,
      store: false,
      truncation: "disabled"
    });
    expect(result.snapshot).toMatchObject({
      settledMicroUsd: 20,
      outstandingReservedMicroUsd: 0,
      responsesStarted: 1
    });
    expect(result.reservation).toMatchObject({
      contextSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      pricingIdentity: {
        model: "test-model",
        requestServiceTier: "default",
        processingRegion: "global"
      },
      providerResponse: {
        id: "resp_test",
        model: "test-model",
        status: "completed"
      }
    });
  });

  it.each([
    { exactInputTokens: 10, expectedMaxOutputTokens: 10 },
    { exactInputTokens: 20, expectedMaxOutputTokens: 5 }
  ])("honors the same approved ceiling after preflight counts $exactInputTokens input tokens", async ({
    exactInputTokens,
    expectedMaxOutputTokens
  }) => {
    const ledger = createLedger();
    const fake = providerFor(async () => terminalResponse({
      usage: {
        inputTokens: exactInputTokens,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        totalTokens: exactInputTokens + 5
      }
    }));
    const result = await executeGovernedResponse({
      ledger,
      provider: {
        ...fake.provider,
        async countInput() { return exactInputTokens; }
      },
      requestId: "approved-request",
      context,
      requestedMaxOutputTokens: 100,
      minimumUsefulOutputTokens: 5,
      maximumCostMicroUsd: 32,
      phase: "work"
    });

    expect(result).toMatchObject({
      status: "settled",
      reservation: {
        exactInputTokens,
        maxOutputTokens: expectedMaxOutputTokens,
        reservedMicroUsd: 32,
        protectedFutureReserveMicroUsd: 30
      }
    });
    expect(fake.created[0]?.max_output_tokens).toBe(expectedMaxOutputTokens);
    expect(fake.counts.create).toBe(1);
    expect(ledger.getSnapshot().settledMicroUsd).toBeLessThanOrEqual(32);
  });

  it("never dispatches or saves when the request ceiling cannot cover useful output", async () => {
    const ledger = createLedger();
    const before = ledger.getState();
    const fake = providerFor();
    const beforeDispatch = vi.fn();
    const result = await executeGovernedResponse({
      ledger,
      provider: fake.provider,
      requestId: "over-request-limit",
      context,
      requestedMaxOutputTokens: 100,
      minimumUsefulOutputTokens: 5,
      maximumCostMicroUsd: 20,
      phase: "work",
      beforeDispatch
    });

    expect(result).toMatchObject({
      status: "denied",
      admission: { reason: "REQUEST_COST_LIMIT", admissibleMaxOutputTokens: 4 }
    });
    expect(fake.counts).toEqual({ preflight: 1, create: 0 });
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(ledger.getState()).toEqual(before);
  });

  it("rejects an invalid request ceiling before reservation or dispatch", async () => {
    const ledger = createLedger();
    const fake = providerFor();
    const result = await executeGovernedResponse({
      ledger,
      provider: fake.provider,
      requestId: "invalid-request-limit",
      context,
      requestedMaxOutputTokens: 100,
      minimumUsefulOutputTokens: 5,
      maximumCostMicroUsd: 0,
      phase: "work"
    });

    expect(result).toMatchObject({ status: "preflight_failed", reason: "INVALID_ARGUMENT" });
    expect(fake.counts).toEqual({ preflight: 1, create: 0 });
    expect(ledger.getState().reservations).toEqual([]);
  });

  it("never dispatches when the exact request cannot preserve the final reserve", async () => {
    const ledger = createLedger(40);
    const fake = providerFor();

    const result = await executeGovernedResponse({
      ledger,
      provider: fake.provider,
      requestId: "too-large",
      context,
      requestedMaxOutputTokens: 10,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });

    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.admission.reason).toBe(
        "INPUT_EXCEEDS_AVAILABLE_BUDGET"
      );
    }
    expect(fake.counts).toEqual({ preflight: 1, create: 0 });
    expect(result.snapshot.activeReservation).toBeNull();
  });

  it("fails safely before creating a reservation when preflight fails", async () => {
    const ledger = createLedger();
    const provider: ResponsesProvider = {
      async countInput() {
        throw new Error("network detail that must not be surfaced");
      },
      async createResponse() {
        throw new Error("must not dispatch");
      }
    };

    const result = await executeGovernedResponse({
      ledger,
      provider,
      requestId: "preflight-failure",
      context,
      requestedMaxOutputTokens: 10,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });

    expect(result).toMatchObject({
      status: "preflight_failed",
      reason: "Error"
    });
    expect(result.snapshot.activeReservation).toBeNull();
  });

  it("does not preflight or reserve an already cancelled request", async () => {
    const ledger = createLedger();
    const fake = providerFor();
    const controller = new AbortController();
    controller.abort();

    const result = await executeGovernedResponse({
      ledger,
      provider: fake.provider,
      requestId: "cancelled-before-preflight",
      context,
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "work",
      signal: controller.signal
    });

    expect(result).toMatchObject({
      status: "preflight_failed",
      reason: "AbortError",
      snapshot: {
        activeReservation: null,
        outstandingReservedMicroUsd: 0,
        responsesStarted: 0
      }
    });
    expect(fake.counts).toEqual({ preflight: 0, create: 0 });
    expect(ledger.getReservation("cancelled-before-preflight")).toBeUndefined();
  });

  it("does not dispatch or retain budget when cancelled as preflight completes", async () => {
    const ledger = createLedger();
    const controller = new AbortController();
    const createResponse = vi.fn(async () => terminalResponse());
    const beforeDispatch = vi.fn();

    const result = await executeGovernedResponse({
      ledger,
      provider: {
        async countInput() {
          controller.abort();
          return 10;
        },
        createResponse
      },
      requestId: "cancelled-after-preflight",
      context,
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "work",
      signal: controller.signal,
      beforeDispatch
    });

    expect(result).toMatchObject({
      status: "preflight_failed",
      reason: "AbortError",
      snapshot: {
        activeReservation: null,
        outstandingReservedMicroUsd: 0,
        responsesStarted: 0
      }
    });
    expect(createResponse).not.toHaveBeenCalled();
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(ledger.getReservation("cancelled-after-preflight")).toBeUndefined();
  });

  it("retains budget when cancellation occurs after the paid request starts", async () => {
    const ledger = createLedger();
    const controller = new AbortController();
    const fake = providerFor(async () => {
      controller.abort();
      throw controller.signal.reason;
    });

    const result = await executeGovernedResponse({
      ledger,
      provider: fake.provider,
      requestId: "cancelled-after-dispatch",
      context,
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "work",
      signal: controller.signal
    });

    expect(fake.counts).toEqual({ preflight: 1, create: 1 });
    expect(result.status).toBe("unresolved");
    expect(result.snapshot.responsesStarted).toBe(1);
    expect(result.snapshot.outstandingReservedMicroUsd).toBeGreaterThan(0);
    expect(ledger.getReservation("cancelled-after-dispatch")?.status).toBe("ambiguous");
  });

  it("rejects previous_response_id before provider preflight", async () => {
    const fake = providerFor();

    const result = await executeGovernedResponse({
      ledger: createLedger(),
      provider: fake.provider,
      requestId: "stateful-context",
      context: {
        ...context,
        previous_response_id: "resp_previous"
      },
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });

    expect(result.status).toBe("preflight_failed");
    expect(fake.counts).toEqual({ preflight: 0, create: 0 });
    expect(result.snapshot.activeReservation).toBeNull();
  });

  it("releases a reservation when dispatch preparation fails", async () => {
    const ledger = createLedger();
    const dispatch = vi
      .spyOn(ledger, "dispatch")
      .mockImplementation(() => {
        throw new Error("dispatch binding failed");
      });
    const fake = providerFor();

    const result = await executeGovernedResponse({
      ledger,
      provider: fake.provider,
      requestId: "dispatch-failure",
      context,
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });

    expect(result.status).toBe("preflight_failed");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(fake.counts).toEqual({ preflight: 1, create: 0 });
    expect(ledger.getReservation("dispatch-failure")).toMatchObject({
      status: "released",
      terminalReason: "released_before_dispatch"
    });
    expect(result.snapshot).toMatchObject({
      activeReservation: null,
      outstandingReservedMicroUsd: 0,
      responsesStarted: 0
    });
  });

  it("retains the full reservation after a dispatched transport failure", async () => {
    const ledger = createLedger();
    const fake = providerFor(async () => {
      throw new Error("socket closed");
    });

    const result = await executeGovernedResponse({
      ledger,
      provider: fake.provider,
      requestId: "ambiguous",
      context,
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });

    expect(result.status).toBe("unresolved");
    if (result.status === "unresolved") {
      expect(result.reason).toBe("transport_error");
      expect(result.reservation).toMatchObject({
        status: "ambiguous",
        ambiguity: { reason: "transport_error" }
      });
      expect(result.snapshot.outstandingReservedMicroUsd).toBe(
        result.reservation.reservedMicroUsd
      );
    }
  });

  it("releases the reservation after a definitive provider rejection", async () => {
    const ledger = createLedger();
    const fake = providerFor(async () => {
      throw new OpenAiApiError("request rejected", {
        status: 429,
        requestId: "req_429",
        ambiguous: false
      });
    });

    const result = await executeGovernedResponse({
      ledger,
      provider: fake.provider,
      requestId: "rejected-429",
      context,
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });

    expect(result.status).toBe("provider_rejected");
    if (result.status === "provider_rejected") {
      expect(result.providerError).toEqual({
        httpStatus: 429,
        requestId: "req_429",
        ambiguous: false
      });
      expect(result.reservation).toMatchObject({
        status: "released",
        terminalReason: "provider_rejected",
        providerRejection: {
          httpStatus: 429,
          requestId: "req_429"
        }
      });
    }
    expect(result.snapshot).toMatchObject({
      settledMicroUsd: 0,
      outstandingReservedMicroUsd: 0,
      activeReservation: null,
      responsesStarted: 1
    });
  });

  it("retains the reservation after an ambiguous provider failure", async () => {
    const ledger = createLedger();
    const fake = providerFor(async () => {
      throw new OpenAiApiError("outcome unknown", {
        status: 500,
        requestId: "req_500",
        ambiguous: true
      });
    });

    const result = await executeGovernedResponse({
      ledger,
      provider: fake.provider,
      requestId: "ambiguous-500",
      context,
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });

    expect(result.status).toBe("unresolved");
    if (result.status === "unresolved") {
      expect(result.reason).toBe("transport_error");
      expect(result.providerError).toEqual({
        httpStatus: 500,
        requestId: "req_500",
        ambiguous: true
      });
      expect(result.reservation.status).toBe("ambiguous");
      expect(result.snapshot.outstandingReservedMicroUsd).toBe(
        result.reservation.reservedMicroUsd
      );
    }
  });

  it("stops with the reservation intact when terminal usage is absent", async () => {
    const ledger = createLedger();
    const fake = providerFor(async () =>
      terminalResponse({ id: "resp_missing_usage", usage: null })
    );

    const result = await executeGovernedResponse({
      ledger,
      provider: fake.provider,
      requestId: "missing-usage",
      context,
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });

    expect(result.status).toBe("unresolved");
    if (result.status === "unresolved") {
      expect(result.reservation.ambiguity?.reason).toBe("missing_usage");
      expect(result.snapshot.settledMicroUsd).toBe(0);
    }
  });

  it("treats usage that differs from the exact preflight as unresolved", async () => {
    const ledger = createLedger();
    const fake = providerFor(async () =>
      terminalResponse({
        usage: {
          inputTokens: 11,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
          totalTokens: 16
        }
      })
    );

    const result = await executeGovernedResponse({
      ledger,
      provider: fake.provider,
      requestId: "usage-mismatch",
      context,
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });

    expect(result.status).toBe("unresolved");
    if (result.status === "unresolved") {
      expect(result.reservation).toMatchObject({
        status: "ambiguous",
        ambiguity: {
          reason: "usage_mismatch",
          observedUsage: { inputTokens: 11 }
        }
      });
      expect(result.snapshot.settledMicroUsd).toBe(0);
    }
  });

  it("rejects relationally invalid usage before ledger settlement", async () => {
    const ledger = createLedger();
    const settle = vi.spyOn(ledger, "settle");
    const fake = providerFor(async () =>
      terminalResponse({
        usage: {
          inputTokens: 10,
          cachedInputTokens: 8,
          cacheWriteInputTokens: 3,
          outputTokens: 5,
          reasoningOutputTokens: 2,
          totalTokens: 15
        }
      })
    );

    const result = await executeGovernedResponse({
      ledger,
      provider: fake.provider,
      requestId: "invalid-provider-usage",
      context,
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });

    expect(result.status).toBe("unresolved");
    if (result.status === "unresolved") {
      expect(result.reason).toBe("provider_protocol_error");
      expect(result.reservation).toMatchObject({
        status: "ambiguous",
        ambiguity: { reason: "provider_protocol_error" }
      });
      expect(result.reservation.ambiguity?.observedUsage).toBeUndefined();
    }
    expect(settle).not.toHaveBeenCalled();
    expect(result.snapshot.settledMicroUsd).toBe(0);
  });

  it("requires application validation after a final response settles", async () => {
    const ledger = createLedger();
    const fake = providerFor();

    const result = await executeGovernedResponse({
      ledger,
      provider: fake.provider,
      requestId: "final",
      context,
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "final"
    });

    expect(result.status).toBe("settled");
    expect(result.snapshot).toMatchObject({
      closed: false,
      pendingFinalValidationRequestId: "final",
      completionAccepted: null
    });
    const finalized = ledger.finalizeFinalResponse("final", true);
    expect(finalized.applicationAccepted).toBe(true);
    expect(ledger.getSnapshot()).toMatchObject({
      closed: true,
      pendingFinalValidationRequestId: null,
      completionAccepted: true
    });
  });

  it("settles an incomplete provider response without closing the final job", async () => {
    const ledger = createLedger();
    const fake = providerFor(async () =>
      terminalResponse({ id: "resp_incomplete", status: "incomplete" })
    );

    const result = await executeGovernedResponse({
      ledger,
      provider: fake.provider,
      requestId: "final-incomplete",
      context,
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "final"
    });

    expect(result.status).toBe("provider_stopped");
    if (result.status === "provider_stopped") {
      expect(result.reason).toBe("incomplete");
      expect(result.reservation.terminalReason).toBe(
        "provider_incomplete"
      );
    }
    expect(result.snapshot.settledMicroUsd).toBeGreaterThan(0);
    expect(result.snapshot.closed).toBe(false);
    expect(result.snapshot.pendingFinalValidationRequestId).toBeNull();
  });

  it("retains the reservation for a nonterminal provider response", async () => {
    const ledger = createLedger();
    const fake = providerFor(async () =>
      terminalResponse({ id: "resp_running", status: "in_progress" })
    );

    const result = await executeGovernedResponse({
      ledger,
      provider: fake.provider,
      requestId: "still-running",
      context,
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });

    expect(result.status).toBe("unresolved");
    if (result.status === "unresolved") {
      expect(result.reason).toBe("nonterminal_response");
      expect(result.reservation.status).toBe("ambiguous");
    }
    expect(result.snapshot.settledMicroUsd).toBe(0);
    expect(result.snapshot.outstandingReservedMicroUsd).toBeGreaterThan(0);
  });

  it("binds count and create to an immutable clone of the proposed context", async () => {
    const mutableInput = {
      messages: [{ role: "user", content: "original diff" }]
    };
    const mutableContext: ResponseContext = {
      ...context,
      input: mutableInput
    };
    let countedContext: ResponseContext | undefined;
    let createdRequest: GovernedResponseRequest | undefined;
    const provider: ResponsesProvider = {
      async countInput(receivedContext) {
        countedContext = receivedContext;
        mutableInput.messages[0].content = "mutated after preflight";
        return 10;
      },
      async createResponse(request) {
        createdRequest = request;
        return terminalResponse();
      }
    };

    const result = await executeGovernedResponse({
      ledger: createLedger(),
      provider,
      requestId: "immutable",
      context: mutableContext,
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });

    expect(result.status).toBe("settled");
    expect(countedContext?.input).toEqual({
      messages: [{ role: "user", content: "original diff" }]
    });
    expect(createdRequest?.input).toEqual(countedContext?.input);
    expect(Object.isFrozen(countedContext?.input)).toBe(true);
  });

  it("preserves an own __proto__ property in canonical request data", async () => {
    const hostileInput = JSON.parse(
      '{"__proto__":{"polluted":true},"safe":"value"}'
    ) as Record<string, unknown>;
    let countedInput: unknown;
    let createdInput: unknown;
    const provider: ResponsesProvider = {
      async countInput(receivedContext) {
        countedInput = receivedContext.input;
        return 10;
      },
      async createResponse(request) {
        createdInput = request.input;
        return terminalResponse();
      }
    };

    const result = await executeGovernedResponse({
      ledger: createLedger(),
      provider,
      requestId: "own-proto-key",
      context: { ...context, input: hostileInput },
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });

    expect(result.status).toBe("settled");
    expect(Object.getPrototypeOf(countedInput)).toBeNull();
    expect(Object.hasOwn(countedInput as object, "__proto__")).toBe(true);
    expect((countedInput as Record<string, unknown>).__proto__).toEqual({
      polluted: true
    });
    expect(createdInput).toBe(countedInput);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects unpriced request options before preflight", async () => {
    const fake = providerFor();
    const unsafeContext = {
      ...context,
      service_tier: "flex"
    } as unknown as ResponseContext;

    const result = await executeGovernedResponse({
      ledger: createLedger(),
      provider: fake.provider,
      requestId: "unsafe-tier",
      context: unsafeContext,
      requestedMaxOutputTokens: 20,
      minimumUsefulOutputTokens: 1,
      phase: "work"
    });

    expect(result.status).toBe("preflight_failed");
    expect(fake.counts).toEqual({ preflight: 0, create: 0 });
  });

  it("rechecks cancellation after persisting dispatch intent before calling the provider", async () => {
    const fake = providerFor();
    const controller = new AbortController();
    const result = await executeGovernedResponse({
      ledger: createLedger(), provider: fake.provider,
      requestId: "cancel-at-dispatch", context,
      requestedMaxOutputTokens: 20, minimumUsefulOutputTokens: 1, phase: "work",
      signal: controller.signal, continueAfterDispatch: true,
      beforeDispatch: () => controller.abort()
    });

    expect(fake.counts).toEqual({ preflight: 1, create: 0 });
    expect(result).toMatchObject({ status: "unresolved",
      reservation: { status: "ambiguous", reservedMicroUsd: 52 },
      snapshot: { settledMicroUsd: 0, outstandingReservedMicroUsd: 52 }
    });
  });
});
