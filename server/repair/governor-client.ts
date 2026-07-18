import { ApiError } from "../errors.js";
import type { GovernedJobService } from "../jobs/index.js";
import type { JsonObject } from "../openai/index.js";

/**
 * Typed adapter around {@link GovernedJobService}. The repair layer no longer
 * embeds the governor core (a ReservationLedger + executeGovernedResponse);
 * instead it drives the governor SERVICE, which is the single spend authority.
 *
 * This module keeps the repair workflow dependency-light: it maps the service's
 * loosely-typed `jobView`/`executionView` records into small, strongly-typed
 * shapes and normalizes the several governed outcomes (including the ones the
 * service surfaces by THROWING an {@link ApiError}) into a single discriminated
 * union the workflow can branch on without any try/catch of its own.
 */

/** Job-policy knobs forwarded verbatim to {@link GovernedJobService.createJob}. */
export interface RepairJobPolicyInput {
  readonly budget_usd: string;
  readonly final_reserve_usd?: string;
  readonly final_input_token_limit?: number;
  readonly minimum_final_output_tokens?: number;
  readonly max_responses?: number;
}

/** Immutable budget accounting projected from the latest `getJob` snapshot. */
export interface BudgetAccounting {
  readonly applicationCeilingMicroUsd: number;
  readonly committedMicroUsd: number;
  readonly availableForWorkMicroUsd: number;
  readonly finalAnswerReserveMicroUsd: number;
  readonly finalAnswerInputTokenLimit: number;
  readonly minimumFinalOutputTokens: number;
  readonly maxResponses: number;
  readonly responsesStarted: number;
}

export interface RepairResponseRequest {
  readonly requestId: string;
  readonly phase: "work" | "final";
  readonly input: unknown;
  readonly instructions?: string;
  readonly tools?: readonly JsonObject[];
  readonly maxOutputTokens: number;
  readonly minimumOutputTokens: number;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

/** Normalized outcome of a single governed response attempt. */
export type NormalizedResponse =
  | {
      readonly status: "settled";
      readonly output: unknown[];
      readonly responseId: string;
      readonly exactInputTokens: number;
      readonly accounting: BudgetAccounting;
    }
  | {
      readonly status: "provider_stopped";
      readonly reason: "failed" | "incomplete" | "cancelled";
      readonly output: unknown[];
      readonly exactInputTokens: number;
      readonly accounting: BudgetAccounting;
    }
  | {
      readonly status: "unresolved";
      readonly accounting: BudgetAccounting;
    }
  | {
      readonly status: "denied" | "preflight_failed" | "provider_rejected";
      readonly accounting: BudgetAccounting;
    };

export interface RepairSession {
  readonly jobId: string;
  getAccounting(): BudgetAccounting;
  respond(request: RepairResponseRequest): Promise<NormalizedResponse>;
  finalize(requestId: string, accepted: boolean): Promise<void>;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Governor service returned a malformed ${label}.`);
  }
  return value as Record<string, unknown>;
}

function readInteger(
  record: Record<string, unknown>,
  key: string,
  label: string
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Governor ${label} is missing a numeric "${key}".`);
  }
  return value as number;
}

function toAccounting(jobView: unknown): BudgetAccounting {
  const job = asRecord(jobView, "job view");
  const policy = asRecord(job.policy, "job policy");
  const accounting = asRecord(job.accounting, "job accounting");
  return Object.freeze({
    applicationCeilingMicroUsd: readInteger(
      policy,
      "budget_micro_usd",
      "policy"
    ),
    committedMicroUsd: readInteger(
      accounting,
      "committed_micro_usd",
      "accounting"
    ),
    availableForWorkMicroUsd: readInteger(
      accounting,
      "available_for_work_micro_usd",
      "accounting"
    ),
    finalAnswerReserveMicroUsd: readInteger(
      policy,
      "final_reserve_micro_usd",
      "policy"
    ),
    finalAnswerInputTokenLimit: readInteger(
      policy,
      "final_input_token_limit",
      "policy"
    ),
    minimumFinalOutputTokens: readInteger(
      policy,
      "minimum_final_output_tokens",
      "policy"
    ),
    maxResponses: readInteger(policy, "max_responses", "policy"),
    responsesStarted: readInteger(
      accounting,
      "responses_started",
      "accounting"
    )
  });
}

function normalizeExecution(
  execution: unknown,
  accounting: BudgetAccounting
): NormalizedResponse {
  const record = asRecord(execution, "execution view");
  switch (record.status) {
    case "settled": {
      const response = asRecord(record.response, "settled response");
      const reservation = asRecord(record.reservation, "settled reservation");
      return {
        status: "settled",
        output: response.output as unknown[],
        responseId: String(response.id),
        exactInputTokens: readInteger(
          reservation,
          "exact_input_tokens",
          "reservation"
        ),
        accounting
      };
    }
    case "provider_stopped": {
      const response = asRecord(record.response, "stopped response");
      const reservation = asRecord(record.reservation, "stopped reservation");
      return {
        status: "provider_stopped",
        reason: record.reason as "failed" | "incomplete" | "cancelled",
        output: response.output as unknown[],
        exactInputTokens: readInteger(
          reservation,
          "exact_input_tokens",
          "reservation"
        ),
        accounting
      };
    }
    default:
      return { status: "unresolved", accounting };
  }
}

function normalizeThrownOutcome(
  error: ApiError,
  accounting: BudgetAccounting
): NormalizedResponse {
  switch (error.code) {
    case "GOVERNOR_DENIED":
      return { status: "denied", accounting };
    case "PREFLIGHT_FAILED":
      return { status: "preflight_failed", accounting };
    case "PROVIDER_REJECTED":
      return { status: "provider_rejected", accounting };
    default:
      throw error;
  }
}

/**
 * Open a governed repair session: create a job, remember its ID, and expose a
 * small typed surface (accounting reads, governed responses, finalization) the
 * workflow drives instead of touching the governor core directly.
 */
export function openRepairSession(
  service: GovernedJobService,
  policy: RepairJobPolicyInput
): RepairSession {
  const created = service.createJob(policy);
  const jobId = String(asRecord(created, "job view").id);

  function getAccounting(): BudgetAccounting {
    return toAccounting(service.getJob(jobId));
  }

  async function respond(
    request: RepairResponseRequest
  ): Promise<NormalizedResponse> {
    const value: Record<string, unknown> = {
      request_id: request.requestId,
      phase: request.phase,
      input: request.input,
      max_output_tokens: request.maxOutputTokens,
      minimum_output_tokens: request.minimumOutputTokens,
      ...(request.instructions === undefined
        ? {}
        : { instructions: request.instructions }),
      ...(request.tools === undefined
        ? {}
        : { tools: request.tools as JsonObject[] }),
      ...(request.model === undefined ? {} : { model: request.model })
    };

    try {
      const result = await service.createResponse(
        jobId,
        value,
        request.signal
      );
      return normalizeExecution(result.body.execution, getAccounting());
    } catch (error) {
      if (error instanceof ApiError) {
        return normalizeThrownOutcome(error, getAccounting());
      }
      throw error;
    }
  }

  async function finalize(
    requestId: string,
    accepted: boolean
  ): Promise<void> {
    service.finalizeJob(jobId, { request_id: requestId, accepted });
  }

  return Object.freeze({
    jobId,
    getAccounting,
    respond,
    finalize
  });
}
