import {
  GovernorError,
  type AdmissionResult,
  type LedgerSnapshot,
  type ProviderResponseEvidence,
  type RequestReservation,
  type ReservationLedger
} from "../governor/index.js";
import type {
  GovernedResponseRequest,
  ProviderUsage as OpenAiProviderUsage,
  ResponseContext,
  TerminalResponse
} from "../openai/index.js";
import { OpenAiApiError } from "../openai/index.js";
import {
  fingerprintGovernedRequest,
  prepareResponseContext
} from "./request-binding.js";

export interface ResponsesProvider {
  countInput(
    context: ResponseContext,
    signal?: AbortSignal
  ): Promise<number>;
  createResponse(
    request: GovernedResponseRequest,
    signal?: AbortSignal
  ): Promise<TerminalResponse>;
}

export type GovernedExecutionInput = {
  ledger: ReservationLedger;
  provider: ResponsesProvider;
  requestId: string;
  context: ResponseContext;
  requestedMaxOutputTokens: number;
  minimumUsefulOutputTokens: number;
  phase: "work" | "final";
  signal?: AbortSignal;
};

export type GovernedExecutionResult =
  | {
      status: "preflight_failed";
      reason: string;
      snapshot: LedgerSnapshot;
    }
  | {
      status: "denied";
      admission: Extract<AdmissionResult, { admitted: false }>;
      snapshot: LedgerSnapshot;
    }
  | {
      status: "unresolved";
      reason:
        | "transport_error"
        | "provider_protocol_error"
        | "nonterminal_response"
        | "missing_usage"
        | "usage_mismatch";
      reservation: RequestReservation;
      response?: TerminalResponse;
      snapshot: LedgerSnapshot;
    }
  | {
      status: "settled";
      response: TerminalResponse;
      reservation: RequestReservation;
      snapshot: LedgerSnapshot;
    }
  | {
      status: "provider_stopped";
      reason: "failed" | "incomplete" | "cancelled";
      response: TerminalResponse;
      reservation: RequestReservation;
      snapshot: LedgerSnapshot;
    };

function safeErrorMessage(error: unknown): string {
  if (error instanceof GovernorError) {
    return error.code;
  }
  return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}

function toGovernorUsage(usage: OpenAiProviderUsage) {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens: usage.totalTokens,
    usageSource: "provider" as const
  };
}

function toProviderEvidence(
  response: TerminalResponse
): ProviderResponseEvidence {
  if (
    response.status === "queued" ||
    response.status === "in_progress"
  ) {
    throw new Error("Provider response is not terminal.");
  }
  return {
    id: response.id,
    model: response.model,
    serviceTier: response.serviceTier,
    status: response.status
  };
}

function ambiguityReasonForError(
  error: unknown
): "transport_error" | "provider_protocol_error" {
  return error instanceof OpenAiApiError && !error.ambiguous
    ? "provider_protocol_error"
    : "transport_error";
}

function settlementAmbiguityReason(
  error: unknown
): "usage_mismatch" | "provider_protocol_error" {
  return error instanceof GovernorError &&
    error.code === "RATE_CARD_MISMATCH"
    ? "provider_protocol_error"
    : "usage_mismatch";
}

export async function executeGovernedResponse(
  input: GovernedExecutionInput
): Promise<GovernedExecutionResult> {
  let prepared: ReturnType<typeof prepareResponseContext>;
  try {
    prepared = prepareResponseContext(input.context);
  } catch (error) {
    return {
      status: "preflight_failed",
      reason: safeErrorMessage(error),
      snapshot: input.ledger.getSnapshot()
    };
  }

  let exactInputTokens: number;
  try {
    exactInputTokens = await input.provider.countInput(
      prepared.context,
      input.signal
    );
  } catch (error) {
    return {
      status: "preflight_failed",
      reason: safeErrorMessage(error),
      snapshot: input.ledger.getSnapshot()
    };
  }

  const pricingIdentity = input.ledger.getPricingIdentity();
  let admission: AdmissionResult;
  try {
    admission = input.ledger.reserve({
      requestId: input.requestId,
      exactInputTokens,
      requestedMaxOutputTokens: input.requestedMaxOutputTokens,
      minimumUsefulOutputTokens: input.minimumUsefulOutputTokens,
      phase: input.phase,
      binding: {
        contextSha256: prepared.sha256,
        model: prepared.context.model,
        serviceTier: prepared.context.service_tier,
        processingRegion: pricingIdentity.processingRegion
      }
    });
  } catch (error) {
    return {
      status: "preflight_failed",
      reason: safeErrorMessage(error),
      snapshot: input.ledger.getSnapshot()
    };
  }
  if (!admission.admitted) {
    return {
      status: "denied",
      admission,
      snapshot: input.ledger.getSnapshot()
    };
  }

  const request: GovernedResponseRequest = {
    ...prepared.context,
    service_tier: "default",
    include: ["reasoning.encrypted_content"],
    max_output_tokens: admission.reservation.maxOutputTokens,
    parallel_tool_calls: false,
    store: false,
    truncation: "disabled"
  };
  input.ledger.dispatch(input.requestId, {
    requestSha256: fingerprintGovernedRequest(request)
  });

  let response: TerminalResponse;
  try {
    response = await input.provider.createResponse(request, input.signal);
  } catch (error) {
    const reason = ambiguityReasonForError(error);
    const reservation = input.ledger.markAmbiguous(
      input.requestId,
      reason
    );
    return {
      status: "unresolved",
      reason,
      reservation,
      snapshot: input.ledger.getSnapshot()
    };
  }

  if (
    response.status === "queued" ||
    response.status === "in_progress"
  ) {
    const reservation = input.ledger.markAmbiguous(
      input.requestId,
      "nonterminal_response",
      response.usage === null
        ? undefined
        : toGovernorUsage(response.usage)
    );
    return {
      status: "unresolved",
      reason: "nonterminal_response",
      reservation,
      response,
      snapshot: input.ledger.getSnapshot()
    };
  }

  if (response.usage === null) {
    const reservation = input.ledger.markAmbiguous(
      input.requestId,
      "missing_usage"
    );
    return {
      status: "unresolved",
      reason: "missing_usage",
      reservation,
      response,
      snapshot: input.ledger.getSnapshot()
    };
  }

  try {
    const reservation = input.ledger.settle(
      input.requestId,
      toGovernorUsage(response.usage),
      toProviderEvidence(response)
    );
    if (response.status !== "completed") {
      return {
        status: "provider_stopped",
        reason: response.status,
        response,
        reservation,
        snapshot: input.ledger.getSnapshot()
      };
    }
    return {
      status: "settled",
      response,
      reservation,
      snapshot: input.ledger.getSnapshot()
    };
  } catch (error) {
    const reason = settlementAmbiguityReason(error);
    const reservation = input.ledger.markAmbiguous(
      input.requestId,
      reason,
      toGovernorUsage(response.usage)
    );
    return {
      status: "unresolved",
      reason,
      reservation,
      response,
      snapshot: input.ledger.getSnapshot()
    };
  }
}
