import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { JobStore } from "./store.js";
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

const listJobsSchema = z.strictObject({
  limit: z.string()
    .regex(/^[1-9]\d{0,2}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .optional(),
  after: z.string().regex(JOB_ID_PATTERN).optional()
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
  minimum_output_tokens: z.number().int().min(1).max(16_384).optional(),
  max_cost_usd: exactUsdSchema.refine((value) => /[1-9]/.test(value), {
    message: "must be a positive decimal USD amount"
  }).optional()
});

const quoteSchema = responseSchema.omit({ request_id: true });

const finalizeSchema = z.strictObject({
  request_id: z.string().regex(REQUEST_ID_PATTERN),
  accepted: z.boolean()
});

type CreateJobRequest = z.infer<typeof createJobSchema>;
type CreateResponseRequest = z.infer<typeof responseSchema>;
type QuoteRequest = z.infer<typeof quoteSchema>;
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

const outcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("response"),
    statusCode: z.union([z.literal(200), z.literal(202)]),
    execution: z.record(z.string(), z.unknown())
  }),
  z.strictObject({
    kind: z.literal("error"),
    statusCode: z.union([z.literal(409), z.literal(502)]),
    code: z.enum(["GOVERNOR_DENIED", "PREFLIGHT_FAILED", "PROVIDER_REJECTED"]),
    message: z.string(),
    execution: z.record(z.string(), z.unknown())
  })
]);

const storedJobSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(JOB_ID_PATTERN),
  createdAt: z.iso.datetime(),
  ledger: z.unknown(),
  nextAttemptSequence: z.number().int().min(1).max(MAX_JOB_RESPONSE_ATTEMPTS + 1),
  attempts: z.array(z.strictObject({
    sequence: z.number().int().positive(),
    requestId: z.string().regex(REQUEST_ID_PATTERN),
    phase: z.enum(["work", "final"]),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    startedAt: z.iso.datetime(),
    outcome: outcomeSchema.optional()
  })).max(MAX_JOB_RESPONSE_ATTEMPTS)
});

export type GovernedJobServiceOptions = {
  readonly provider?: ResponsesProvider;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
  readonly store?: JobStore;
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

function validateSavedOutcome(ledger: ReservationLedger, attempt: ResponseAttempt): void {
  const outcome = attempt.outcome;
  if (outcome === undefined) return;
  const reservation = ledger.getReservation(attempt.requestId);
  const execution = outcome.execution;
  const fail = (): never => {
    throw new Error(`Saved response ${attempt.requestId} does not match its ledger.`);
  };
  if (reservation !== undefined && !isDeepStrictEqual(execution.reservation, reservationView(reservation))) {
    if (execution.status !== "preflight_failed") fail();
  }
  switch (execution.status) {
    case "settled":
    case "provider_stopped": {
      if (outcome.kind !== "response" || outcome.statusCode !== 200 || reservation?.status !== "settled") fail();
      const response = execution.response;
      if (typeof response !== "object" || response === null || Array.isArray(response)) fail();
      const saved = response as Record<string, unknown>;
      const evidence = reservation!.providerResponse!;
      const usage = reservation!.usage!;
      if (
        saved.id !== evidence.id || saved.model !== evidence.model ||
        saved.status !== evidence.status || saved.service_tier !== evidence.serviceTier ||
        !Array.isArray(saved.output) ||
        (execution.status === "settled") !== (evidence.status === "completed") ||
        !isDeepStrictEqual(saved.usage, {
          input_tokens: usage.inputTokens,
          cached_input_tokens: usage.cachedInputTokens,
          cache_write_input_tokens: usage.cacheWriteTokens,
          output_tokens: usage.outputTokens,
          reasoning_output_tokens: usage.reasoningOutputTokens,
          total_tokens: usage.totalTokens
        })
      ) fail();
      return;
    }
    case "unresolved":
      if (outcome.kind !== "response" || outcome.statusCode !== 202 || reservation?.status !== "ambiguous") fail();
      return;
    case "provider_rejected":
      if (outcome.kind !== "error" || outcome.code !== "PROVIDER_REJECTED" || outcome.statusCode !== 502 ||
        reservation?.status !== "released" || reservation.providerRejection === undefined) fail();
      return;
    case "denied":
      if (outcome.kind !== "error" || outcome.code !== "GOVERNOR_DENIED" || outcome.statusCode !== 409 || reservation !== undefined) fail();
      return;
    case "preflight_failed":
      if (outcome.kind !== "error" || outcome.code !== "PREFLIGHT_FAILED" || outcome.statusCode !== 502 ||
        (reservation !== undefined && (reservation.status !== "released" || reservation.requestSha256 !== undefined))) fail();
      return;
    default:
      fail();
  }
}

function jobStatus(
  snapshot: LedgerSnapshot,
  attempts: ReadonlyMap<string, ResponseAttempt>
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
  if (snapshot.activeReservation !== null ||
    [...attempts.values()].some((attempt) => attempt.outcome === undefined)) {
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
    status: jobStatus(snapshot, record.attempts),
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
  minimumUsefulOutputTokens: number,
  maximumCostMicroUsd?: number
): {
  readonly context: ResponseContext;
  readonly contextSha256: string;
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
        minimum_useful_output_tokens: minimumUsefulOutputTokens,
        ...(maximumCostMicroUsd === undefined ? {} : { maximum_cost_micro_usd: maximumCostMicroUsd })
      }),
      "utf8"
    )
    .digest("hex");
  return {
    context: prepared.context,
    contextSha256: prepared.sha256,
    fingerprint
  };
}

function prepareResponseInput(record: JobRecord, input: QuoteRequest) {
  const pricing = record.ledger.getPricingIdentity();
  const model = input.model ?? pricing.model;
  if (model !== pricing.model) {
    throw new ApiError("MODEL_NOT_PRICED", `This POC has a pinned rate card for ${pricing.model}.`, 400);
  }
  const defaultMinimumOutputTokens = input.phase === "final"
    ? record.ledger.getSnapshot().policy.minimumFinalOutputTokens
    : DEFAULT_WORK_MINIMUM_OUTPUT_TOKENS;
  const defaultMaxOutputTokens = input.phase === "final"
    ? Math.max(DEFAULT_FINAL_MAX_OUTPUT_TOKENS, defaultMinimumOutputTokens)
    : DEFAULT_WORK_MAX_OUTPUT_TOKENS;
  const maxOutputTokens = input.max_output_tokens ?? defaultMaxOutputTokens;
  const minimumOutputTokens = input.minimum_output_tokens ?? defaultMinimumOutputTokens;
  if (minimumOutputTokens > maxOutputTokens) {
    throw new ApiError("INVALID_RESPONSE_REQUEST", "minimum_output_tokens cannot exceed max_output_tokens.", 400);
  }
  if (input.phase === "final" && (input.tools?.length ?? 0) > 0) {
    throw new ApiError("FINAL_TOOLS_NOT_ALLOWED", "Final responses cannot declare tools.", 400);
  }
  const maximumCostMicroUsd = input.max_cost_usd === undefined
    ? undefined
    : parseUsdToMicroUsd(input.max_cost_usd);
  const intent = responseIntentFingerprint({
    model,
    input: input.input,
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.tools === undefined ? {} : { tools: input.tools as JsonObject[] }),
    service_tier: "default"
  }, input.phase, maxOutputTokens, minimumOutputTokens, maximumCostMicroUsd);
  return { ...intent, maxOutputTokens, minimumOutputTokens, maximumCostMicroUsd };
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
  #state: { jobs: Map<string, JobRecord>; store?: JobStore; failed: boolean };

  constructor(options: GovernedJobServiceOptions = {}) {
    this.#provider = options.provider;
    this.#idFactory =
      options.idFactory ??
      (() => `job_${randomUUID().replaceAll("-", "")}`);
    this.#now = options.now ?? (() => new Date());
    this.#state = { jobs: new Map(), store: options.store, failed: false };
    for (const value of options.store?.load() ?? []) {
      const stored = storedJobSchema.parse(value);
      const ledger = ReservationLedger.restore(stored.ledger, GPT_5_4_MINI_STANDARD_RATE_CARD);
      const attempts = new Map<string, ResponseAttempt>();
      stored.attempts.forEach((attempt, index) => {
        if (attempts.has(attempt.requestId) || attempt.sequence !== index + 1) {
          throw new Error(`Invalid request sequence in saved job ${stored.id}.`);
        }
        attempts.set(attempt.requestId, attempt);
      });
      if (stored.nextAttemptSequence !== attempts.size + 1 || this.#state.jobs.has(stored.id)) {
        throw new Error(`Invalid saved job ${stored.id}.`);
      }
      for (const reservation of ledger.getState().reservations) {
        if (attempts.get(reservation.requestId)?.phase !== reservation.phase) {
          throw new Error(`Missing request receipt in saved job ${stored.id}.`);
        }
      }
      for (const attempt of attempts.values()) validateSavedOutcome(ledger, attempt);
      this.#state.jobs.set(stored.id, {
        id: stored.id,
        createdAt: stored.createdAt,
        ledger,
        attempts,
        nextAttemptSequence: stored.nextAttemptSequence
      });
    }
    for (const record of this.#state.jobs.values()) {
      this.#recoverInterrupted(record);
    }
  }

  withProvider(provider: ResponsesProvider): GovernedJobService {
    const service = new GovernedJobService({ provider, idFactory: this.#idFactory, now: this.#now });
    service.#state = this.#state;
    return service;
  }

  createJob(value: unknown): Record<string, unknown> {
    this.#assertAvailable();
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
    if (!JOB_ID_PATTERN.test(id) || this.#state.jobs.has(id)) {
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
    this.#persist(record);
    this.#state.jobs.set(id, record);
    return jobView(record);
  }

  getJob(id: string): Record<string, unknown> {
    return jobView(this.#requireJob(id));
  }

  getReport(id: string) {
    const record = this.#requireJob(id);
    return {
      object: "token_governor.report" as const,
      schema_version: 1 as const,
      generated_at: this.#now().toISOString(),
      content_included: false as const,
      job: jobView(record),
      requests: [...record.attempts.values()].map((attempt) => {
        const reservation = record.ledger.getReservation(attempt.requestId);
        const usage = reservation?.usage;
        const reason: unknown = attempt.outcome?.execution.reason;
        return {
          ...attemptSummary(attempt, id),
          outcome_code: attempt.outcome?.kind === "error" ? attempt.outcome.code : null,
          reason: typeof reason === "string" ? reason : null,
          reservation: reservation === undefined ? null : {
            ...reservationView(reservation),
            protected_final_reserve_usd: formatMicroUsd(reservation.protectedFutureReserveMicroUsd)
          },
          usage: usage === undefined ? null : {
            input_tokens: usage.inputTokens,
            cached_input_tokens: usage.cachedInputTokens,
            cache_write_input_tokens: usage.cacheWriteTokens,
            output_tokens: usage.outputTokens,
            reasoning_output_tokens: usage.reasoningOutputTokens,
            total_tokens: usage.totalTokens ?? null
          },
          provider_response_id: reservation?.providerResponse?.id ?? null
        };
      })
    };
  }

  listJobs(value: unknown = {}) {
    this.#assertAvailable();
    const input = parseBody(listJobsSchema, value, "INVALID_JOB_LIST_QUERY");
    if (input.after !== undefined && !this.#state.jobs.has(input.after)) {
      throw new ApiError(
        "INVALID_JOB_CURSOR",
        "after must identify an existing job in this service.",
        400
      );
    }
    const jobs = [...this.#state.jobs.values()].sort((left, right) => {
      const createdDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      if (createdDifference !== 0) return createdDifference;
      return left.id === right.id ? 0 : left.id < right.id ? 1 : -1;
    });
    const start = input.after === undefined
      ? 0
      : jobs.findIndex((record) => record.id === input.after) + 1;
    const limit = input.limit ?? 25;
    const page = jobs.slice(start, start + limit);
    const hasMore = start + page.length < jobs.length;
    const data = page.map((record) => {
      const snapshot = record.ledger.getSnapshot();
      return {
        id: record.id,
        created_at: record.createdAt,
        status: jobStatus(snapshot, record.attempts),
        budget_usd: formatMicroUsd(snapshot.policy.applicationCeilingMicroUsd),
        settled_usd: formatMicroUsd(snapshot.settledMicroUsd),
        reserved_usd: formatMicroUsd(snapshot.outstandingReservedMicroUsd),
        responses_started: snapshot.responsesStarted,
        max_responses: snapshot.policy.maxResponses
      };
    });
    return {
      object: "list" as const,
      data,
      has_more: hasMore,
      next_after: hasMore ? page[page.length - 1].id : null
    };
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

  async quoteResponse(id: string, value: unknown, signal?: AbortSignal) {
    const record = this.#requireJob(id);
    const input = parseBody(quoteSchema, value, "INVALID_QUOTE_REQUEST");
    const intent = prepareResponseInput(record, input);
    const provider = this.#assertResponseAvailable(record);
    signal?.throwIfAborted();
    let exactInputTokens: number;
    try {
      exactInputTokens = await provider.countInput(intent.context, signal);
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(exactInputTokens) || exactInputTokens < 0) {
        throw new Error("Invalid input-token count.");
      }
    } catch {
      signal?.throwIfAborted();
      throw new ApiError("PREFLIGHT_FAILED", "The quote could not be counted by the provider.", 502);
    }
    this.#assertResponseAvailable(record);
    const ledger = ReservationLedger.restore(record.ledger.getState(), GPT_5_4_MINI_STANDARD_RATE_CARD);
    const pricing = ledger.getPricingIdentity();
    const admission = ledger.reserve({
      requestId: `quote:${randomUUID()}`,
      exactInputTokens,
      requestedMaxOutputTokens: intent.maxOutputTokens,
      minimumUsefulOutputTokens: intent.minimumOutputTokens,
      maximumCostMicroUsd: intent.maximumCostMicroUsd,
      phase: input.phase,
      binding: {
        contextSha256: intent.contextSha256,
        model: intent.context.model,
        serviceTier: "default",
        processingRegion: pricing.processingRegion
      }
    });
    const snapshot = ledger.getSnapshot();
    const cost = calculateWorstCaseRequestCost(
      GPT_5_4_MINI_STANDARD_RATE_CARD,
      exactInputTokens,
      admission.admitted ? admission.reservation.maxOutputTokens : 0
    );
    return {
      object: "token_governor.quote" as const,
      job_id: id,
      quoted_at: this.#now().toISOString(),
      phase: input.phase,
      model: pricing.model,
      rate_card_version: pricing.rateCardVersion,
      context_sha256: intent.contextSha256,
      admitted: admission.admitted,
      reason: admission.admitted ? null : admission.reason,
      exact_input_tokens: exactInputTokens,
      requested_max_output_tokens: intent.maxOutputTokens,
      max_output_tokens: admission.admitted
        ? admission.reservation.maxOutputTokens
        : admission.admissibleMaxOutputTokens,
      minimum_output_tokens: input.phase === "final"
        ? Math.max(intent.minimumOutputTokens, snapshot.policy.minimumFinalOutputTokens)
        : intent.minimumOutputTokens,
      max_cost_micro_usd: admission.admitted ? admission.reservation.reservedMicroUsd : null,
      max_cost_usd: admission.admitted ? formatMicroUsd(admission.reservation.reservedMicroUsd) : null,
      input_cost_usd: formatMicroUsd(cost.inputMicroUsd),
      output_cost_usd: admission.admitted ? formatMicroUsd(cost.outputMicroUsd) : null,
      protected_final_reserve_usd: formatMicroUsd(input.phase === "work" ? snapshot.policy.finalAnswerReserveMicroUsd : 0),
      available_after_usd: admission.admitted
        ? formatMicroUsd(input.phase === "work" ? snapshot.availableForWorkMicroUsd : snapshot.uncommittedMicroUsd)
        : null
    };
  }

  async createResponse(
    id: string,
    value: unknown,
    signal?: AbortSignal,
    options: { continueAfterDispatch?: boolean } = {}
  ): Promise<GovernedResponseServiceResult> {
    const record = this.#requireJob(id);
    const input = parseBody(
      responseSchema,
      value,
      "INVALID_RESPONSE_REQUEST"
    );
    const intent = prepareResponseInput(record, input);
    const { maxOutputTokens, minimumOutputTokens, maximumCostMicroUsd } = intent;
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
    this.#assertResponseAvailable(record);

    const attempt: ResponseAttempt = {
      sequence: record.nextAttemptSequence++,
      requestId: input.request_id,
      phase: input.phase,
      fingerprint: intent.fingerprint,
      startedAt: this.#now().toISOString()
    };
    record.attempts.set(input.request_id, attempt);
    this.#persist(record);
    attempt.promise = this.#executeAttempt(
      record,
      attempt,
      intent.context,
      maxOutputTokens,
      minimumOutputTokens,
      maximumCostMicroUsd,
      signal,
      options.continueAfterDispatch ?? false
    ).then((outcome) => {
      attempt.outcome = outcome;
      attempt.promise = undefined;
      this.#persist(record);
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
    if ([...record.attempts.values()].some((attempt) => attempt.promise !== undefined)) {
      throw new ApiError(
        "JOB_BUSY",
        "Wait for the current response attempt before finalizing the job.",
        409
      );
    }
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
    this.#persist(record);
    return jobView(record);
  }

  #assertResponseAvailable(record: JobRecord): ResponsesProvider {
    this.#assertAvailable();
    if (this.#provider === undefined) {
      throw new ApiError("PROVIDER_NOT_CONFIGURED", "Set OPENAI_API_KEY before dispatching governed responses.", 503);
    }
    if ([...record.attempts.values()].some((attempt) => attempt.promise !== undefined)) {
      throw new ApiError("JOB_BUSY", "Wait for the current response attempt before submitting another request.", 409);
    }
    if (record.attempts.size >= MAX_JOB_RESPONSE_ATTEMPTS) {
      throw new ApiError("ATTEMPT_LIMIT_REACHED", `A job can record at most ${MAX_JOB_RESPONSE_ATTEMPTS} response attempts.`, 429);
    }
    return this.#provider;
  }

  async #executeAttempt(
    record: JobRecord,
    attempt: ResponseAttempt,
    context: ResponseContext,
    maxOutputTokens: number,
    minimumOutputTokens: number,
    maximumCostMicroUsd: number | undefined,
    signal: AbortSignal | undefined,
    continueAfterDispatch: boolean
  ): Promise<AttemptOutcome> {
    const result = await executeGovernedResponse({
      ledger: record.ledger,
      provider: this.#provider!,
      requestId: attempt.requestId,
      context,
      requestedMaxOutputTokens: maxOutputTokens,
      minimumUsefulOutputTokens: minimumOutputTokens,
      maximumCostMicroUsd,
      phase: attempt.phase,
      signal,
      continueAfterDispatch,
      beforeDispatch: () => this.#persist(record)
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
    this.#assertAvailable();
    if (!JOB_ID_PATTERN.test(id)) {
      throw new ApiError(
        "INVALID_JOB_ID",
        "The job ID is malformed.",
        400
      );
    }
    const record = this.#state.jobs.get(id);
    if (record === undefined) {
      throw new ApiError(
        "JOB_NOT_FOUND",
        "The governed job does not exist in this service.",
        404
      );
    }
    return record;
  }

  #assertAvailable(): void {
    try {
      if (this.#state.failed) {
        throw new Error("A previous job storage write failed.");
      }
      this.#state.store?.assertAvailable();
    } catch {
      throw new ApiError("STORAGE_UNAVAILABLE", "Job storage is unavailable. Restart the service before spending.", 503);
    }
  }

  #persist(record: JobRecord): void {
    this.#assertAvailable();
    try {
      this.#state.store?.save(record.id, {
        version: 1,
        id: record.id,
        createdAt: record.createdAt,
        ledger: record.ledger.getState(),
        nextAttemptSequence: record.nextAttemptSequence,
        attempts: [...record.attempts.values()].map(({ promise: _promise, ...attempt }) => attempt)
      });
    } catch {
      this.#state.failed = true;
      throw new ApiError("STORAGE_UNAVAILABLE", "The job could not be saved. Further spending is blocked until the service restarts.", 503);
    }
  }

  #recoverInterrupted(record: JobRecord): void {
    let changed = false;
    for (const attempt of record.attempts.values()) {
      if (attempt.outcome !== undefined) continue;
      let reservation = record.ledger.getReservation(attempt.requestId);
      if (reservation?.status === "in_flight") {
        reservation = record.ledger.markAmbiguous(attempt.requestId, "transport_error");
      }
      if (reservation?.status === "ambiguous") {
        attempt.outcome = {
          kind: "response",
          statusCode: 202,
          execution: {
            status: "unresolved",
            reason: "service_restarted",
            reservation: reservationView(reservation),
            response: null,
            provider_error: null
          }
        };
      } else if (reservation === undefined || reservation.status === "reserved") {
        if (reservation !== undefined) record.ledger.release(attempt.requestId);
        attempt.outcome = {
          kind: "error",
          statusCode: 502,
          code: "PREFLIGHT_FAILED",
          message: "The service restarted before dispatch. Submit a new request ID to continue.",
          execution: { status: "preflight_failed", reason: "service_restarted" }
        };
      } else {
        throw new Error(`Missing completed response in saved job ${record.id}.`);
      }
      changed = true;
    }
    if (changed) this.#persist(record);
  }
}
