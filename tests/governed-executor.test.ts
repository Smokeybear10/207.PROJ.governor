import { describe, expect, it } from "vitest";
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
});
