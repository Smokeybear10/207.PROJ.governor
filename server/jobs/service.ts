import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../errors.js";
import {
  GPT_5_4_MINI_STANDARD_RATE_CARD,
  GovernorError,
  ReservationLedger,
  calculateWorstCaseRequestCost,
  createGovernorPolicy,
  type LedgerSnapshot,
  type RequestReservation
} from "../governor/index.js";
import type {
  JsonObject,
  ResponseContext,
  TerminalResponse
} from "../openai/index.js";
import { OpenAiApiError } from "../openai/index.js";
import {
  executeGovernedResponse,
  prepareResponseContext,
  type GovernedExecutionResult,
  type ProviderErrorEvidence,
  type ResponsesProvider
} from "../runtime/index.js";

const JOB_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const USD_PATTERN = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/;
const MAX_BUDGET_MICRO_USD = 1_000_000_000_000;
const DEFAULT_FINAL_INPUT_TOKEN_LIMIT = 8_192;
const DEFAULT_MINIMUM_FINAL_OUTPUT_TOKENS = 256;
const DEFAULT_MAX_RESPONSES = 4;
const DEFAULT_WORK_MAX_OUTPUT_TOKENS = 768;
const DEFAULT_WORK_MINIMUM_OUTPUT_TOKENS = 64;
const DEFAULT_FINAL_MAX_OUTPUT_TOKENS = 1_200;
const MAX_JOB_RESPONSE_ATTEMPTS = 64;

const exactUsdSchema = z
  .string()
  .regex(
    USD_PATTERN,
    "must be a non-negative decimal USD string with at most six fractional digits"
  );

const createJobSchema = z.strictObject({
  budget_usd: exactUsdSchema,
  final_reserve_usd: exactUsdSchema.optional(),
  final_input_token_limit: z.number().int().min(1).max(1_000_000).optional(),
  minimum_final_output_tokens: z.number().int().min(1).max(16_384).optional(),
  max_responses: z.number().int().min(1).max(32).optional()
});

const responseSchema = z.strictObject({
  request_id: z.string().regex(REQUEST_ID_PATTERN),
  phase: z.enum(["work", "final"]),
  model: z.string().min(1).max(128).optional(),
  input: z.custom<unknown>((value) => value !== undefined, {
    message: "input is required"
  }),
  instructions: z.string().max(32_768).optional(),
  tools: z
    .array(z.record(z.string(), z.unknown()))
    .max(32)
    .optional(),
  max_output_tokens: z.number().int().min(1).max(16_384).optional(),
  minimum_output_tokens: z.number().int().min(1).max(16_384).optional()
});

const finalizeSchema = z.strictObject({
  request_id: z.string().regex(REQUEST_ID_PATTERN),
  accepted: z.boolean()
});

type CreateJobRequest = z.infer<typeof createJobSchema>;
type CreateResponseRequest = z.infer<typeof responseSchema>;
type FinalizeRequest = z.infer<typeof finalizeSchema>;

type AttemptOutcome =
  | {
      readonly kind: "response";
      readonly statusCode: 200 | 202;
      readonly execution: Record<string, unknown>;
    }
  | {
      readonly kind: "error";
      readonly statusCode: 409 | 502;
      readonly code:
        | "GOVERNOR_DENIED"
        | "PREFLIGHT_FAILED"
        | "PROVIDER_REJECTED";
      readonly message: string;
      readonly execution: Record<string, unknown>;
    };

type ResponseAttempt = {
  readonly sequence: number;
  readonly requestId: string;
  readonly phase: "work" | "final";
  readonly fingerprint: string;
  readonly startedAt: string;
  outcome?: AttemptOutcome;
  promise?: Promise<AttemptOutcome>;
};

type JobRecord = {
  readonly id: string;
  readonly createdAt: string;
  readonly ledger: ReservationLedger;
  readonly attempts: Map<string, ResponseAttempt>;
  nextAttemptSequence: number;
};

export type GovernedJobServiceOptions = {
  readonly provider?: ResponsesProvider;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
};

export type GovernedResponseServiceResult = {
  readonly statusCode: 200 | 202;
  readonly body: Record<string, unknown>;
};

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "body";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function parseBody<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: string
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(code, validationMessage(parsed.error), 400);
  }
  return parsed.data;
}

export function parseUsdToMicroUsd(value: string): number {
  if (!USD_PATTERN.test(value)) {
    throw new ApiError(
      "INVALID_USD_AMOUNT",
      "USD amounts must be decimal strings with at most six fractional digits.",
      400
    );
  }

  const [whole, fractional = ""] = value.split(".");
  const microUsd =
    BigInt(whole) * 1_000_000n +
    BigInt(fractional.padEnd(6, "0"));
  if (
    microUsd < 0n ||
    microUsd > BigInt(MAX_BUDGET_MICRO_USD) ||
    microUsd > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new ApiError(
      "INVALID_USD_AMOUNT",
      "USD amount is outside the supported range.",
      400
    );
  }
  return Number(microUsd);
}

export function formatMicroUsd(microUsd: number): string {
  if (!Number.isSafeInteger(microUsd) || microUsd < 0) {
    throw new Error("microUsd must be a non-negative safe integer.");
  }
  const whole = Math.floor(microUsd / 1_000_000);
  const fractional = String(microUsd % 1_000_000).padStart(6, "0");
  return `${whole}.${fractional}`;
}

function reservationView(
  reservation: RequestReservation
): Record<string, unknown> {
  return {
    request_id: reservation.requestId,
    phase: reservation.phase,
    status: reservation.status,
    exact_input_tokens: reservation.exactInputTokens,
    max_output_tokens: reservation.maxOutputTokens,
    reserved_micro_usd: reservation.reservedMicroUsd,
    reserved_usd: formatMicroUsd(reservation.reservedMicroUsd),
    settled_micro_usd: reservation.settledMicroUsd ?? null,
    settled_usd:
      reservation.settledMicroUsd === undefined
        ? null
        : formatMicroUsd(reservation.settledMicroUsd),
    context_sha256: reservation.contextSha256,
    request_sha256: reservation.requestSha256 ?? null,
    ambiguity: reservation.ambiguity ?? null,
    provider_rejection:
      reservation.providerRejection === undefined
        ? null
        : {
            http_status: reservation.providerRejection.httpStatus,
            provider_request_id:
              reservation.providerRejection.requestId ?? null
          },
    terminal_reason: reservation.terminalReason ?? null
  };
}

function attemptSummary(
  attempt: ResponseAttempt,
  jobId: string
): Record<string, unknown> {
  return {
    sequence: attempt.sequence,
    request_id: attempt.requestId,
    phase: attempt.phase,
    request_fingerprint: attempt.fingerprint,
    started_at: attempt.startedAt,
    status:
      attempt.outcome === undefined
        ? "in_progress"
        : attempt.outcome.execution.status,
    retrieve_path: `/v1/jobs/${encodeURIComponent(jobId)}/responses/${encodeURIComponent(attempt.requestId)}`
  };
}

function jobStatus(
  snapshot: LedgerSnapshot
):
  | "open"
  | "response_in_flight"
  | "reconciliation_required"
  | "validation_required"
  | "completed"
  | "rejected" {
  if (snapshot.closed) {
    return snapshot.completionAccepted ? "completed" : "rejected";
  }
  if (snapshot.pendingFinalValidationRequestId !== null) {
    return "validation_required";
  }
  if (snapshot.activeReservation?.status === "ambiguous") {
    return "reconciliation_required";
  }
  if (snapshot.activeReservation !== null) {
    return "response_in_flight";
  }
  return "open";
}

function jobView(record: JobRecord): Record<string, unknown> {
  const snapshot = record.ledger.getSnapshot();
  const pricing = record.ledger.getPricingIdentity();
  return {
    id: record.id,
    object: "token_governor.job",
    created_at: record.createdAt,
    status: jobStatus(snapshot),
    policy: {
      budget_micro_usd: snapshot.policy.applicationCeilingMicroUsd,
      budget_usd: formatMicroUsd(
        snapshot.policy.applicationCeilingMicroUsd
      ),
      final_reserve_micro_usd:
        snapshot.policy.finalAnswerReserveMicroUsd,
      final_reserve_usd: formatMicroUsd(
        snapshot.policy.finalAnswerReserveMicroUsd
      ),
      final_input_token_limit:
        snapshot.policy.finalAnswerInputTokenLimit,
      minimum_final_output_tokens:
        snapshot.policy.minimumFinalOutputTokens,
      max_responses: snapshot.policy.maxResponses
    },
    pricing: {
      provider: pricing.provider,
      model: pricing.model,
      service_tier: pricing.serviceTier,
      request_service_tier: pricing.requestServiceTier,
      processing_region: pricing.processingRegion,
      rate_card_version: pricing.rateCardVersion,
      rate_card_source: GPT_5_4_MINI_STANDARD_RATE_CARD.source,
      rate_card_effective_at:
        GPT_5_4_MINI_STANDARD_RATE_CARD.effectiveAt,
      rates_micro_usd_per_million_tokens:
        GPT_5_4_MINI_STANDARD_RATE_CARD.rates
    },
    accounting: {
      settled_micro_usd: snapshot.settledMicroUsd,
      settled_usd: formatMicroUsd(snapshot.settledMicroUsd),
      reserved_micro_usd: snapshot.outstandingReservedMicroUsd,
      reserved_usd: formatMicroUsd(
        snapshot.outstandingReservedMicroUsd
      ),
      committed_micro_usd: snapshot.committedMicroUsd,
      committed_usd: formatMicroUsd(snapshot.committedMicroUsd),
      uncommitted_micro_usd: snapshot.uncommittedMicroUsd,
      uncommitted_usd: formatMicroUsd(snapshot.uncommittedMicroUsd),
      available_for_work_micro_usd:
        snapshot.availableForWorkMicroUsd,
      available_for_work_usd: formatMicroUsd(
        snapshot.availableForWorkMicroUsd
      ),
      responses_started: snapshot.responsesStarted
    },
    pending_final_validation_request_id:
      snapshot.pendingFinalValidationRequestId,
    completion_accepted: snapshot.completionAccepted,
    requests: [...record.attempts.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map((attempt) => attemptSummary(attempt, record.id)),
    active_request:
      snapshot.activeReservation === null
        ? null
        : reservationView(snapshot.activeReservation)
  };
}

function responseIntentFingerprint(
  context: ResponseContext,
  phase: "work" | "final",
  requestedMaxOutputTokens: number,
  minimumUsefulOutputTokens: number
): {
  readonly context: ResponseContext;
  readonly fingerprint: string;
} {
  let prepared: ReturnType<typeof prepareResponseContext>;
  try {
    prepared = prepareResponseContext(context);
  } catch (error) {
    if (error instanceof OpenAiApiError) {
      throw new ApiError(
        "INVALID_RESPONSE_CONTEXT",
        error.message,
        400
      );
    }
    throw error;
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        context_sha256: prepared.sha256,
        phase,
        requested_max_output_tokens: requestedMaxOutputTokens,
        minimum_useful_output_tokens: minimumUsefulOutputTokens
      }),
      "utf8"
    )
    .digest("hex");
  return {
    context: prepared.context,
    fingerprint
  };
}

function providerResponseView(
  response: TerminalResponse
): Record<string, unknown> {
  return {
    id: response.id,
    model: response.model,
    provider_model: response.providerModel ?? response.model,
    service_tier: response.serviceTier,
    status: response.status,
    output: response.output,
    usage:
      response.usage === null
        ? null
        : {
            input_tokens: response.usage.inputTokens,
            cached_input_tokens: response.usage.cachedInputTokens,
            cache_write_input_tokens:
              response.usage.cacheWriteInputTokens,
            output_tokens: response.usage.outputTokens,
            reasoning_output_tokens:
              response.usage.reasoningOutputTokens,
            total_tokens: response.usage.totalTokens
          },
    provider_request_id: response.requestId ?? null
  };
}

function providerErrorView(
  error: ProviderErrorEvidence
): Record<string, unknown> {
  return {
    http_status: error.httpStatus,
    provider_request_id: error.requestId ?? null,
    ambiguous: error.ambiguous
  };
}

function executionView(
  result: GovernedExecutionResult
): Record<string, unknown> {
  switch (result.status) {
    case "settled":
      return {
        status: result.status,
        response: providerResponseView(result.response),
        reservation: reservationView(result.reservation)
      };
    case "provider_stopped":
      return {
        status: result.status,
        reason: result.reason,
        response: providerResponseView(result.response),
        reservation: reservationView(result.reservation)
      };
    case "provider_rejected":
      return {
        status: result.status,
        provider_error: providerErrorView(result.providerError),
        reservation: reservationView(result.reservation)
      };
    case "unresolved":
      return {
        status: result.status,
        reason: result.reason,
        provider_error:
          result.providerError === undefined
            ? null
            : providerErrorView(result.providerError),
        response:
          result.response === undefined
            ? null
            : providerResponseView(result.response),
        reservation: reservationView(result.reservation)
      };
    case "denied":
      return {
        status: result.status,
        reason: result.admission.reason,
        admission: result.admission
      };
    case "preflight_failed":
      return {
        status: result.status,
        reason: result.reason
      };
  }
}

export class GovernedJobService {
  readonly #provider?: ResponsesProvider;
  readonly #idFactory: () => string;
  readonly #now: () => Date;
  readonly #jobs = new Map<string, JobRecord>();

  constructor(options: GovernedJobServiceOptions = {}) {
    this.#provider = options.provider;
    this.#idFactory =
      options.idFactory ??
      (() => `job_${randomUUID().replaceAll("-", "")}`);
    this.#now = options.now ?? (() => new Date());
  }

  createJob(value: unknown): Record<string, unknown> {
    const input = parseBody(
      createJobSchema,
      value,
      "INVALID_JOB_REQUEST"
    );
    const budgetMicroUsd = parseUsdToMicroUsd(input.budget_usd);
    if (budgetMicroUsd < 1) {
      throw new ApiError(
        "BUDGET_TOO_LOW",
        "budget_usd must be at least 0.000001.",
        400
      );
    }

    const finalInputTokenLimit =
      input.final_input_token_limit ??
      DEFAULT_FINAL_INPUT_TOKEN_LIMIT;
    const minimumFinalOutputTokens =
      input.minimum_final_output_tokens ??
      DEFAULT_MINIMUM_FINAL_OUTPUT_TOKENS;
    const minimumFinalReserveMicroUsd =
      calculateWorstCaseRequestCost(
        GPT_5_4_MINI_STANDARD_RATE_CARD,
        finalInputTokenLimit,
        minimumFinalOutputTokens
      ).totalMicroUsd;
    const defaultFinalReserveMicroUsd = Math.max(
      minimumFinalReserveMicroUsd,
      Math.ceil(budgetMicroUsd / 5)
    );
    const finalReserveMicroUsd =
      input.final_reserve_usd === undefined
        ? defaultFinalReserveMicroUsd
        : parseUsdToMicroUsd(input.final_reserve_usd);

    if (minimumFinalReserveMicroUsd > budgetMicroUsd) {
      throw new ApiError(
        "BUDGET_TOO_LOW",
        `The budget cannot fund the configured final request; at least ${formatMicroUsd(minimumFinalReserveMicroUsd)} USD is required.`,
        400
      );
    }
    if (finalReserveMicroUsd > budgetMicroUsd) {
      throw new ApiError(
        "INVALID_FINAL_RESERVE",
        "final_reserve_usd cannot exceed budget_usd.",
        400
      );
    }
    if (finalReserveMicroUsd < minimumFinalReserveMicroUsd) {
      throw new ApiError(
        "INVALID_FINAL_RESERVE",
        `final_reserve_usd must be at least ${formatMicroUsd(minimumFinalReserveMicroUsd)} for the configured final request.`,
        400
      );
    }

    const id = this.#idFactory();
    if (!JOB_ID_PATTERN.test(id) || this.#jobs.has(id)) {
      throw new ApiError(
        "JOB_ID_UNAVAILABLE",
        "A unique job ID could not be allocated.",
        500
      );
    }

    let ledger: ReservationLedger;
    try {
      ledger = new ReservationLedger(
        createGovernorPolicy({
          applicationCeilingMicroUsd: budgetMicroUsd,
          finalAnswerReserveMicroUsd: finalReserveMicroUsd,
          finalAnswerInputTokenLimit: finalInputTokenLimit,
          minimumFinalOutputTokens,
          maxResponses: input.max_responses ?? DEFAULT_MAX_RESPONSES,
          maxEquivalentRetries: 0,
          rateCardVersion: GPT_5_4_MINI_STANDARD_RATE_CARD.version
        }),
        GPT_5_4_MINI_STANDARD_RATE_CARD
      );
    } catch (error) {
      if (error instanceof GovernorError) {
        throw new ApiError(
          "INVALID_JOB_POLICY",
          `${error.code}: ${error.message}`,
          400
        );
      }
      throw error;
    }

    const record: JobRecord = {
      id,
      createdAt: this.#now().toISOString(),
      ledger,
      attempts: new Map(),
      nextAttemptSequence: 1
    };
    this.#jobs.set(id, record);
    return jobView(record);
  }

  getJob(id: string): Record<string, unknown> {
    return jobView(this.#requireJob(id));
  }

  async getResponse(
    id: string,
    requestId: string
  ): Promise<GovernedResponseServiceResult> {
    const record = this.#requireJob(id);
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw new ApiError(
        "INVALID_REQUEST_ID",
        "The request ID is malformed.",
        400
      );
    }
    const attempt = record.attempts.get(requestId);
    if (attempt === undefined) {
      throw new ApiError(
        "RESPONSE_NOT_FOUND",
        "The governed response attempt does not exist.",
        404
      );
    }
    const outcome = await this.#awaitAttempt(attempt);
    return {
      statusCode: 200,
      body: this.#responseBody(record, attempt, outcome)
    };
  }

  async createResponse(
    id: string,
    value: unknown
  ): Promise<GovernedResponseServiceResult> {
    const record = this.#requireJob(id);
    const input = parseBody(
      responseSchema,
      value,
      "INVALID_RESPONSE_REQUEST"
    );
    if (this.#provider === undefined) {
      throw new ApiError(
        "PROVIDER_NOT_CONFIGURED",
        "Set OPENAI_API_KEY before dispatching governed responses.",
        503
      );
    }

    const pricing = record.ledger.getPricingIdentity();
    const model = input.model ?? pricing.model;
    if (model !== pricing.model) {
      throw new ApiError(
        "MODEL_NOT_PRICED",
        `This POC has a pinned rate card for ${pricing.model}.`,
        400
      );
    }

    const defaultMinimumOutputTokens =
      input.phase === "final"
        ? record.ledger.getSnapshot().policy
            .minimumFinalOutputTokens
        : DEFAULT_WORK_MINIMUM_OUTPUT_TOKENS;
    const defaultMaxOutputTokens =
      input.phase === "final"
        ? Math.max(
            DEFAULT_FINAL_MAX_OUTPUT_TOKENS,
            defaultMinimumOutputTokens
          )
        : DEFAULT_WORK_MAX_OUTPUT_TOKENS;
    const maxOutputTokens =
      input.max_output_tokens ?? defaultMaxOutputTokens;
    const minimumOutputTokens =
      input.minimum_output_tokens ??
      defaultMinimumOutputTokens;
    if (minimumOutputTokens > maxOutputTokens) {
      throw new ApiError(
        "INVALID_RESPONSE_REQUEST",
        "minimum_output_tokens cannot exceed max_output_tokens.",
        400
      );
    }
    if (input.phase === "final" && (input.tools?.length ?? 0) > 0) {
      throw new ApiError(
        "FINAL_TOOLS_NOT_ALLOWED",
        "Final responses cannot declare tools.",
        400
      );
    }

    const proposedContext: ResponseContext = {
      model,
      input: input.input,
      ...(input.instructions === undefined
        ? {}
        : { instructions: input.instructions }),
      ...(input.tools === undefined
        ? {}
        : { tools: input.tools as JsonObject[] }),
      service_tier: "default"
    };
    const intent = responseIntentFingerprint(
      proposedContext,
      input.phase,
      maxOutputTokens,
      minimumOutputTokens
    );
    const existing = record.attempts.get(input.request_id);
    if (existing !== undefined) {
      if (existing.fingerprint !== intent.fingerprint) {
        throw new ApiError(
          "REQUEST_ID_CONFLICT",
          "request_id was already used with a different governed response.",
          409
        );
      }
      const outcome = await this.#awaitAttempt(existing);
      return this.#materializeOutcome(record, existing, outcome);
    }
    if (record.attempts.size >= MAX_JOB_RESPONSE_ATTEMPTS) {
      throw new ApiError(
        "ATTEMPT_LIMIT_REACHED",
        `A job can record at most ${MAX_JOB_RESPONSE_ATTEMPTS} response attempts.`,
        429
      );
    }

    const attempt: ResponseAttempt = {
      sequence: record.nextAttemptSequence++,
      requestId: input.request_id,
      phase: input.phase,
      fingerprint: intent.fingerprint,
      startedAt: this.#now().toISOString()
    };
    record.attempts.set(input.request_id, attempt);
    attempt.promise = this.#executeAttempt(
      record,
      attempt,
      intent.context,
      maxOutputTokens,
      minimumOutputTokens
    ).then((outcome) => {
      attempt.outcome = outcome;
      attempt.promise = undefined;
      return outcome;
    });
    const outcome = await attempt.promise;
    return this.#materializeOutcome(record, attempt, outcome);
  }

  finalizeJob(id: string, value: unknown): Record<string, unknown> {
    const record = this.#requireJob(id);
    const input = parseBody(
      finalizeSchema,
      value,
      "INVALID_FINALIZE_REQUEST"
    );
    try {
      record.ledger.finalizeFinalResponse(
        input.request_id,
        input.accepted
      );
    } catch (error) {
      if (error instanceof GovernorError) {
        throw new ApiError(
          "FINALIZATION_REJECTED",
          `${error.code}: ${error.message}`,
          409
        );
      }
      throw error;
    }
    return jobView(record);
  }

  async #executeAttempt(
    record: JobRecord,
    attempt: ResponseAttempt,
    context: ResponseContext,
    maxOutputTokens: number,
    minimumOutputTokens: number
  ): Promise<AttemptOutcome> {
    const result = await executeGovernedResponse({
      ledger: record.ledger,
      provider: this.#provider!,
      requestId: attempt.requestId,
      context,
      requestedMaxOutputTokens: maxOutputTokens,
      minimumUsefulOutputTokens: minimumOutputTokens,
      phase: attempt.phase
    });
    const execution = structuredClone(executionView(result));
    if (result.status === "denied") {
      return {
        kind: "error",
        statusCode: 409,
        code: "GOVERNOR_DENIED",
        message: `The request was denied: ${result.admission.reason}.`,
        execution
      };
    }
    if (result.status === "preflight_failed") {
      return {
        kind: "error",
        statusCode: 502,
        code: "PREFLIGHT_FAILED",
        message: `The request could not be preflighted: ${result.reason}.`,
        execution
      };
    }
    if (result.status === "provider_rejected") {
      return {
        kind: "error",
        statusCode: 502,
        code: "PROVIDER_REJECTED",
        message: `The provider rejected the request with HTTP ${result.providerError.httpStatus}.`,
        execution
      };
    }
    return {
      kind: "response",
      statusCode: result.status === "unresolved" ? 202 : 200,
      execution
    };
  }

  async #awaitAttempt(attempt: ResponseAttempt): Promise<AttemptOutcome> {
    if (attempt.outcome !== undefined) {
      return attempt.outcome;
    }
    if (attempt.promise === undefined) {
      throw new ApiError(
        "ATTEMPT_STATE_INVALID",
        "The response attempt has no recoverable outcome.",
        500
      );
    }
    return attempt.promise;
  }

  #responseBody(
    record: JobRecord,
    attempt: ResponseAttempt,
    outcome: AttemptOutcome
  ): Record<string, unknown> {
    return {
      object: "token_governor.response",
      request_fingerprint: attempt.fingerprint,
      execution: structuredClone(outcome.execution),
      job: jobView(record)
    };
  }

  #materializeOutcome(
    record: JobRecord,
    attempt: ResponseAttempt,
    outcome: AttemptOutcome
  ): GovernedResponseServiceResult {
    const body = this.#responseBody(record, attempt, outcome);
    if (outcome.kind === "error") {
      throw new ApiError(
        outcome.code,
        outcome.message,
        outcome.statusCode,
        body
      );
    }
    return {
      statusCode: outcome.statusCode,
      body
    };
  }

  #requireJob(id: string): JobRecord {
    if (!JOB_ID_PATTERN.test(id)) {
      throw new ApiError(
        "INVALID_JOB_ID",
        "The job ID is malformed.",
        400
      );
    }
    const record = this.#jobs.get(id);
    if (record === undefined) {
      throw new ApiError(
        "JOB_NOT_FOUND",
        "The governed job does not exist in this process.",
        404
      );
    }
    return record;
  }
}
