import {
  calculateAdmissibleOutputCap,
  calculateUsageCost,
  calculateWorstCaseRequestCost,
  createRateCard,
  normalizeProviderUsage,
  type NormalizedProviderUsage,
  type ProviderUsage,
  type RateCard
} from "./cost.js";
import {
  assertGovernor,
  requireNonEmptyString,
  requireNonNegativeSafeInteger,
  requirePositiveSafeInteger,
  safeIntegerFromBigInt
} from "./errors.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface GovernorPolicy {
  readonly applicationCeilingMicroUsd: number;
  readonly finalAnswerReserveMicroUsd: number;
  readonly finalAnswerInputTokenLimit: number;
  readonly minimumFinalOutputTokens: number;
  readonly maxResponses: number;
  readonly maxEquivalentRetries: number;
  readonly rateCardVersion: string;
}

export interface ExactInputAdmission {
  readonly requestId: string;
  readonly exactInputTokens: number;
  readonly requestedMaxOutputTokens: number;
  readonly minimumUsefulOutputTokens: number;
  readonly phase: "work" | "final";
  readonly binding: RequestBinding;
}

export interface RequestPricingIdentity {
  readonly provider: string;
  readonly model: string;
  readonly serviceTier: string;
  readonly requestServiceTier: "default";
  readonly processingRegion: string;
  readonly rateCardVersion: string;
}

export interface RequestBinding {
  readonly contextSha256: string;
  readonly model: string;
  readonly serviceTier: "default";
  readonly processingRegion: string;
}

export interface DispatchBinding {
  readonly requestSha256: string;
}

export type ProviderTerminalStatus =
  | "completed"
  | "failed"
  | "incomplete"
  | "cancelled";

export interface ProviderResponseEvidence {
  readonly id: string;
  readonly model: string;
  readonly serviceTier: "default";
  readonly status: ProviderTerminalStatus;
}

export interface ProviderRejectionEvidence {
  readonly httpStatus: number;
  readonly requestId?: string;
}

export type ReservationStatus =
  | "reserved"
  | "in_flight"
  | "ambiguous"
  | "settled"
  | "released";

export interface ProviderUsageObservation {
  readonly usageSource: "provider";
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly totalTokens?: number;
}

export interface AmbiguityRecord {
  readonly reason:
    | "timeout"
    | "cancellation"
    | "transport_error"
    | "missing_usage"
    | "usage_mismatch"
    | "nonterminal_response"
    | "provider_protocol_error";
  readonly observedUsage?: ProviderUsageObservation;
}

export type AmbiguityReason = AmbiguityRecord["reason"];

export type ReservationTerminalReason =
  | "provider_completed"
  | "provider_failed"
  | "provider_incomplete"
  | "provider_cancelled"
  | "provider_rejected"
  | "cancelled_with_usage"
  | "cancelled_before_dispatch"
  | "released_before_dispatch";

export interface RequestReservation {
  readonly requestId: string;
  readonly exactInputTokens: number;
  readonly maxOutputTokens: number;
  readonly reservedMicroUsd: number;
  readonly protectedFutureReserveMicroUsd: number;
  readonly contextSha256: string;
  readonly requestSha256?: string;
  readonly pricingIdentity: RequestPricingIdentity;
  readonly rateCardVersion: string;
  readonly phase: "work" | "final";
  readonly status: ReservationStatus;
  readonly settledMicroUsd?: number;
  readonly usage?: NormalizedProviderUsage;
  readonly providerResponse?: ProviderResponseEvidence;
  readonly providerRejection?: ProviderRejectionEvidence;
  readonly applicationAccepted?: boolean;
  readonly ambiguity?: AmbiguityRecord;
  readonly terminalReason?: ReservationTerminalReason;
}

export type AdmissionDenialReason =
  | "DUPLICATE_REQUEST_ID"
  | "INPUT_EXCEEDS_AVAILABLE_BUDGET"
  | "JOB_CLOSED"
  | "FINAL_INPUT_LIMIT_EXCEEDED"
  | "OUTPUT_BELOW_MINIMUM"
  | "RESPONSE_LIMIT_REACHED"
  | "UNRESOLVED_REQUEST";

export type AdmissionResult =
  | {
      readonly admitted: true;
      readonly reservation: RequestReservation;
    }
  | {
      readonly admitted: false;
      readonly reason: AdmissionDenialReason;
      readonly availableMicroUsd: number;
      readonly admissibleMaxOutputTokens: number;
    };

export interface LedgerSnapshot {
  readonly policy: GovernorPolicy;
  readonly settledMicroUsd: number;
  readonly outstandingReservedMicroUsd: number;
  readonly committedMicroUsd: number;
  readonly uncommittedMicroUsd: number;
  readonly availableForWorkMicroUsd: number;
  readonly responsesStarted: number;
  readonly closed: boolean;
  readonly pendingFinalValidationRequestId: string | null;
  readonly completionAccepted: boolean | null;
  readonly activeReservation: RequestReservation | null;
}

export type ProviderReconciliation = {
  readonly kind: "usage";
  readonly usage: ProviderUsage;
  readonly evidence: ProviderResponseEvidence;
};

export type CancellationResolution =
  | ProviderReconciliation
  | {
      readonly kind: "unknown";
      readonly observedUsage?: ProviderUsageObservation;
    };

interface MutableReservation {
  requestId: string;
  exactInputTokens: number;
  maxOutputTokens: number;
  reservedMicroUsd: number;
  protectedFutureReserveMicroUsd: number;
  contextSha256: string;
  requestSha256?: string;
  pricingIdentity: RequestPricingIdentity;
  rateCardVersion: string;
  phase: "work" | "final";
  status: ReservationStatus;
  settledMicroUsd?: number;
  usage?: NormalizedProviderUsage;
  providerResponse?: ProviderResponseEvidence;
  providerRejection?: ProviderRejectionEvidence;
  applicationAccepted?: boolean;
  ambiguity?: AmbiguityRecord;
  terminalReason?: ReservationTerminalReason;
}

export function createGovernorPolicy(
  policy: GovernorPolicy
): GovernorPolicy {
  const applicationCeilingMicroUsd = requirePositiveSafeInteger(
    policy.applicationCeilingMicroUsd,
    "applicationCeilingMicroUsd"
  );
  const finalAnswerReserveMicroUsd = requireNonNegativeSafeInteger(
    policy.finalAnswerReserveMicroUsd,
    "finalAnswerReserveMicroUsd"
  );
  requirePositiveSafeInteger(
    policy.finalAnswerInputTokenLimit,
    "finalAnswerInputTokenLimit"
  );
  requirePositiveSafeInteger(
    policy.minimumFinalOutputTokens,
    "minimumFinalOutputTokens"
  );
  assertGovernor(
    finalAnswerReserveMicroUsd <= applicationCeilingMicroUsd,
    "INVALID_ARGUMENT",
    "finalAnswerReserveMicroUsd cannot exceed the application ceiling."
  );
  requirePositiveSafeInteger(policy.maxResponses, "maxResponses");
  requireNonNegativeSafeInteger(
    policy.maxEquivalentRetries,
    "maxEquivalentRetries"
  );
  requireNonEmptyString(policy.rateCardVersion, "rateCardVersion");
  return Object.freeze({ ...policy });
}

function copyUsageObservation(
  observation: ProviderUsageObservation
): ProviderUsageObservation {
  assertGovernor(
    observation.usageSource === "provider",
    "INVALID_USAGE",
    "Observed usage must come from the provider."
  );
  const numericFields = [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens"
  ] as const;
  for (const field of numericFields) {
    const value = observation[field];
    if (value !== undefined) {
      requireNonNegativeSafeInteger(value, field, "INVALID_USAGE");
    }
  }

  if (
    observation.inputTokens !== undefined &&
    observation.cachedInputTokens !== undefined &&
    observation.cacheWriteTokens !== undefined
  ) {
    assertGovernor(
      BigInt(observation.cachedInputTokens) +
        BigInt(observation.cacheWriteTokens) <=
        BigInt(observation.inputTokens),
      "INVALID_USAGE",
      "Observed cached and cache-write partitions cannot exceed inputTokens."
    );
  }
  if (
    observation.outputTokens !== undefined &&
    observation.reasoningOutputTokens !== undefined
  ) {
    assertGovernor(
      observation.reasoningOutputTokens <= observation.outputTokens,
      "INVALID_USAGE",
      "Observed reasoning output cannot exceed outputTokens."
    );
  }

  return Object.freeze({ ...observation });
}

function snapshotReservation(
  reservation: MutableReservation
): RequestReservation {
  return Object.freeze({
    requestId: reservation.requestId,
    exactInputTokens: reservation.exactInputTokens,
    maxOutputTokens: reservation.maxOutputTokens,
    reservedMicroUsd: reservation.reservedMicroUsd,
    protectedFutureReserveMicroUsd:
      reservation.protectedFutureReserveMicroUsd,
    contextSha256: reservation.contextSha256,
    ...(reservation.requestSha256 === undefined
      ? {}
      : { requestSha256: reservation.requestSha256 }),
    pricingIdentity: reservation.pricingIdentity,
    rateCardVersion: reservation.rateCardVersion,
    phase: reservation.phase,
    status: reservation.status,
    ...(reservation.settledMicroUsd === undefined
      ? {}
      : { settledMicroUsd: reservation.settledMicroUsd }),
    ...(reservation.usage === undefined
      ? {}
      : { usage: reservation.usage }),
    ...(reservation.providerResponse === undefined
      ? {}
      : { providerResponse: reservation.providerResponse }),
    ...(reservation.providerRejection === undefined
      ? {}
      : { providerRejection: reservation.providerRejection }),
    ...(reservation.applicationAccepted === undefined
      ? {}
      : { applicationAccepted: reservation.applicationAccepted }),
    ...(reservation.ambiguity === undefined
      ? {}
      : {
          ambiguity: Object.freeze({
            ...reservation.ambiguity,
            ...(reservation.ambiguity.observedUsage === undefined
              ? {}
              : {
                  observedUsage:
                    reservation.ambiguity.observedUsage
                })
          })
        }),
    ...(reservation.terminalReason === undefined
      ? {}
      : { terminalReason: reservation.terminalReason })
  });
}

function denied(
  reason: AdmissionDenialReason,
  availableMicroUsd: number,
  admissibleMaxOutputTokens = 0
): AdmissionResult {
  return Object.freeze({
    admitted: false as const,
    reason,
    availableMicroUsd,
    admissibleMaxOutputTokens
  });
}

export class ReservationLedger {
  readonly #policy: GovernorPolicy;
  readonly #rateCard: RateCard;
  readonly #pricingIdentity: RequestPricingIdentity;
  readonly #reservations = new Map<string, MutableReservation>();
  readonly #settledProviderResponseIds = new Set<string>();
  #activeRequestId: string | null = null;
  #settledMicroUsd = 0;
  #responsesStarted = 0;
  #closed = false;
  #pendingFinalValidationRequestId: string | null = null;
  #completionAccepted: boolean | null = null;

  constructor(policy: GovernorPolicy, rateCard: RateCard) {
    this.#policy = createGovernorPolicy(policy);
    this.#rateCard = createRateCard(rateCard);
    assertGovernor(
      this.#policy.rateCardVersion === this.#rateCard.version,
      "RATE_CARD_MISMATCH",
      "The policy rate-card version does not match the supplied rate card."
    );
    assertGovernor(
      this.#rateCard.serviceTier === "standard" ||
        this.#rateCard.serviceTier === "default",
      "INVALID_RATE_CARD",
      "The governed POC supports standard/default service-tier pricing only."
    );
    this.#pricingIdentity = Object.freeze({
      provider: this.#rateCard.provider,
      model: this.#rateCard.model,
      serviceTier: this.#rateCard.serviceTier,
      requestServiceTier: "default" as const,
      processingRegion: this.#rateCard.processingRegion,
      rateCardVersion: this.#rateCard.version
    });
    const boundedFinalCost = calculateWorstCaseRequestCost(
      this.#rateCard,
      this.#policy.finalAnswerInputTokenLimit,
      this.#policy.minimumFinalOutputTokens
    ).totalMicroUsd;
    assertGovernor(
      this.#policy.finalAnswerReserveMicroUsd >= boundedFinalCost,
      "INVALID_ARGUMENT",
      "finalAnswerReserveMicroUsd cannot fund the bounded final request."
    );
  }

  getPricingIdentity(): RequestPricingIdentity {
    return this.#pricingIdentity;
  }

  reserve(input: ExactInputAdmission): AdmissionResult {
    requireNonEmptyString(input.requestId, "requestId");
    requireNonNegativeSafeInteger(
      input.exactInputTokens,
      "exactInputTokens"
    );
    requirePositiveSafeInteger(
      input.requestedMaxOutputTokens,
      "requestedMaxOutputTokens"
    );
    requirePositiveSafeInteger(
      input.minimumUsefulOutputTokens,
      "minimumUsefulOutputTokens"
    );
    assertGovernor(
      input.minimumUsefulOutputTokens <=
        input.requestedMaxOutputTokens,
      "INVALID_ARGUMENT",
      "minimumUsefulOutputTokens cannot exceed requestedMaxOutputTokens."
    );
    assertGovernor(
      input.phase === "work" || input.phase === "final",
      "INVALID_ARGUMENT",
      "phase must be either work or final."
    );
    this.#assertRequestBinding(input.binding);

    const availableMicroUsd = this.#availableFor(input.phase);
    if (this.#closed) {
      return denied("JOB_CLOSED", availableMicroUsd);
    }
    if (this.#pendingFinalValidationRequestId !== null) {
      return denied("UNRESOLVED_REQUEST", availableMicroUsd);
    }
    if (this.#activeRequestId !== null) {
      return denied("UNRESOLVED_REQUEST", availableMicroUsd);
    }
    if (this.#reservations.has(input.requestId)) {
      return denied("DUPLICATE_REQUEST_ID", availableMicroUsd);
    }
    if (this.#responseLimitReached(input.phase)) {
      return denied("RESPONSE_LIMIT_REACHED", availableMicroUsd);
    }
    if (
      input.phase === "final" &&
      input.exactInputTokens >
        this.#policy.finalAnswerInputTokenLimit
    ) {
      return denied("FINAL_INPUT_LIMIT_EXCEEDED", availableMicroUsd);
    }

    const effectiveMinimumOutputTokens =
      input.phase === "final"
        ? Math.max(
            input.minimumUsefulOutputTokens,
            this.#policy.minimumFinalOutputTokens
          )
        : input.minimumUsefulOutputTokens;

    const admissibleMaxOutputTokens = calculateAdmissibleOutputCap(
      this.#rateCard,
      input.exactInputTokens,
      availableMicroUsd,
      input.requestedMaxOutputTokens
    );
    if (admissibleMaxOutputTokens < effectiveMinimumOutputTokens) {
      const inputCost = calculateWorstCaseRequestCost(
        this.#rateCard,
        input.exactInputTokens,
        0
      ).inputMicroUsd;
      return denied(
        inputCost > availableMicroUsd
          ? "INPUT_EXCEEDS_AVAILABLE_BUDGET"
          : "OUTPUT_BELOW_MINIMUM",
        availableMicroUsd,
        admissibleMaxOutputTokens
      );
    }

    const worstCaseCost = calculateWorstCaseRequestCost(
      this.#rateCard,
      input.exactInputTokens,
      admissibleMaxOutputTokens
    );
    assertGovernor(
      worstCaseCost.totalMicroUsd <= availableMicroUsd,
      "RESERVATION_BREACH",
      "Calculated reservation exceeds the available budget."
    );

    const reservation: MutableReservation = {
      requestId: input.requestId,
      exactInputTokens: input.exactInputTokens,
      maxOutputTokens: admissibleMaxOutputTokens,
      reservedMicroUsd: worstCaseCost.totalMicroUsd,
      protectedFutureReserveMicroUsd:
        input.phase === "work"
          ? this.#policy.finalAnswerReserveMicroUsd
          : 0,
      contextSha256: input.binding.contextSha256,
      pricingIdentity: this.#pricingIdentity,
      rateCardVersion: this.#rateCard.version,
      phase: input.phase,
      status: "reserved"
    };
    this.#reservations.set(input.requestId, reservation);
    this.#activeRequestId = input.requestId;
    return Object.freeze({
      admitted: true as const,
      reservation: snapshotReservation(reservation)
    });
  }

  dispatch(
    requestId: string,
    binding: DispatchBinding
  ): RequestReservation {
    const reservation = this.#requireActive(requestId, ["reserved"]);
    this.#assertSha256(binding.requestSha256, "requestSha256");
    assertGovernor(
      !this.#responseLimitReached(reservation.phase),
      "INVALID_TRANSITION",
      "No response slot remains for this request phase."
    );
    reservation.requestSha256 = binding.requestSha256;
    reservation.status = "in_flight";
    this.#responsesStarted += 1;
    return snapshotReservation(reservation);
  }

  settle(
    requestId: string,
    usage: ProviderUsage,
    evidence: ProviderResponseEvidence
  ): RequestReservation {
    const reservation = this.#requireActive(requestId, ["in_flight"]);
    return this.#settleReservation(reservation, usage, evidence);
  }

  releaseProviderRejection(
    requestId: string,
    evidence: ProviderRejectionEvidence
  ): RequestReservation {
    const reservation = this.#requireActive(requestId, ["in_flight"]);
    assertGovernor(
      Number.isSafeInteger(evidence.httpStatus) &&
        evidence.httpStatus >= 400 &&
        evidence.httpStatus < 500 &&
        evidence.httpStatus !== 408,
      "INVALID_ARGUMENT",
      "Provider rejection evidence must contain a definitive 4xx status."
    );
    if (evidence.requestId !== undefined) {
      requireNonEmptyString(evidence.requestId, "provider request id");
    }
    reservation.status = "released";
    reservation.providerRejection = Object.freeze({ ...evidence });
    reservation.terminalReason = "provider_rejected";
    reservation.ambiguity = undefined;
    this.#activeRequestId = null;
    return snapshotReservation(reservation);
  }

  markTimedOut(
    requestId: string,
    observedUsage?: ProviderUsageObservation
  ): RequestReservation {
    return this.markAmbiguous(requestId, "timeout", observedUsage);
  }

  markAmbiguous(
    requestId: string,
    reason: Exclude<AmbiguityReason, "cancellation">,
    observedUsage?: ProviderUsageObservation
  ): RequestReservation {
    assertGovernor(
      reason === "timeout" ||
        reason === "transport_error" ||
        reason === "missing_usage" ||
        reason === "usage_mismatch" ||
        reason === "nonterminal_response" ||
        reason === "provider_protocol_error",
      "INVALID_ARGUMENT",
      "Unknown ambiguity reason."
    );
    const reservation = this.#requireActive(requestId, ["in_flight"]);
    reservation.status = "ambiguous";
    reservation.ambiguity = Object.freeze({
      reason,
      ...(observedUsage === undefined
        ? {}
        : { observedUsage: copyUsageObservation(observedUsage) })
    });
    return snapshotReservation(reservation);
  }

  reconcile(
    requestId: string,
    resolution: ProviderReconciliation
  ): RequestReservation {
    const reservation = this.#requireActive(requestId, ["ambiguous"]);
    assertGovernor(
      resolution.kind === "usage",
      "INVALID_ARGUMENT",
      "Unknown reconciliation kind."
    );
    return this.#settleReservation(
      reservation,
      resolution.usage,
      resolution.evidence
    );
  }

  release(requestId: string): RequestReservation {
    const reservation = this.#requireActive(requestId, ["reserved"]);
    return this.#releaseReservation(
      reservation,
      "released_before_dispatch"
    );
  }

  cancel(
    requestId: string,
    resolution: CancellationResolution = { kind: "unknown" }
  ): RequestReservation {
    assertGovernor(
      resolution.kind === "usage" ||
        resolution.kind === "unknown",
      "INVALID_ARGUMENT",
      "Unknown cancellation resolution kind."
    );
    const reservation = this.#requireActive(requestId, [
      "reserved",
      "in_flight",
      "ambiguous"
    ]);

    if (reservation.status === "reserved") {
      assertGovernor(
        resolution.kind !== "usage",
        "INVALID_TRANSITION",
        "A request cannot have provider usage before dispatch."
      );
      assertGovernor(
        resolution.kind !== "unknown" ||
          resolution.observedUsage === undefined,
        "INVALID_TRANSITION",
        "A request cannot have observed provider usage before dispatch."
      );
      return this.#releaseReservation(
        reservation,
        "cancelled_before_dispatch"
      );
    }

    if (resolution.kind === "usage") {
      return this.#settleReservation(
        reservation,
        resolution.usage,
        resolution.evidence,
        "cancelled_with_usage"
      );
    }

    if (reservation.status === "in_flight") {
      reservation.status = "ambiguous";
      reservation.ambiguity = Object.freeze({
        reason: "cancellation" as const,
        ...(resolution.observedUsage === undefined
          ? {}
          : {
              observedUsage: copyUsageObservation(
                resolution.observedUsage
              )
            })
      });
    } else if (resolution.observedUsage !== undefined) {
      reservation.ambiguity = Object.freeze({
        reason: reservation.ambiguity?.reason ?? "cancellation",
        observedUsage: copyUsageObservation(
          resolution.observedUsage
        )
      });
    }
    return snapshotReservation(reservation);
  }

  getReservation(requestId: string): RequestReservation | undefined {
    const reservation = this.#reservations.get(requestId);
    return reservation === undefined
      ? undefined
      : snapshotReservation(reservation);
  }

  finalizeFinalResponse(
    requestId: string,
    applicationAccepted: boolean
  ): RequestReservation {
    assertGovernor(
      typeof applicationAccepted === "boolean",
      "INVALID_ARGUMENT",
      "applicationAccepted must be a boolean."
    );
    const reservation = this.#reservations.get(requestId);
    assertGovernor(
      reservation !== undefined,
      "RESERVATION_NOT_FOUND",
      `Reservation ${requestId} does not exist.`
    );
    assertGovernor(
      !this.#closed &&
        this.#pendingFinalValidationRequestId === requestId &&
        reservation.phase === "final" &&
        reservation.status === "settled" &&
        reservation.providerResponse?.status === "completed",
      "INVALID_TRANSITION",
      `Reservation ${requestId} is not awaiting final validation.`
    );

    reservation.applicationAccepted = applicationAccepted;
    this.#pendingFinalValidationRequestId = null;
    this.#completionAccepted = applicationAccepted;
    this.#closed = true;
    return snapshotReservation(reservation);
  }

  closeStoppedJob(): LedgerSnapshot {
    assertGovernor(
      !this.#closed &&
        this.#activeRequestId === null &&
        this.#pendingFinalValidationRequestId === null,
      "INVALID_TRANSITION",
      "Only an inactive job without pending final validation can be stopped."
    );
    this.#closed = true;
    this.#completionAccepted = false;
    return this.getSnapshot();
  }

  getSnapshot(): LedgerSnapshot {
    const active =
      this.#activeRequestId === null
        ? null
        : this.#reservations.get(this.#activeRequestId) ?? null;
    const outstandingReservedMicroUsd = active?.reservedMicroUsd ?? 0;
    const committedMicroUsd = safeIntegerFromBigInt(
      BigInt(this.#settledMicroUsd) +
        BigInt(outstandingReservedMicroUsd),
      "Committed ledger cost"
    );
    return Object.freeze({
      policy: this.#policy,
      settledMicroUsd: this.#settledMicroUsd,
      outstandingReservedMicroUsd,
      committedMicroUsd,
      uncommittedMicroUsd:
        this.#policy.applicationCeilingMicroUsd - committedMicroUsd,
      availableForWorkMicroUsd: Math.max(
        0,
        this.#policy.applicationCeilingMicroUsd -
          committedMicroUsd -
          this.#policy.finalAnswerReserveMicroUsd
      ),
      responsesStarted: this.#responsesStarted,
      closed: this.#closed,
      pendingFinalValidationRequestId:
        this.#pendingFinalValidationRequestId,
      completionAccepted: this.#completionAccepted,
      activeReservation:
        active === null ? null : snapshotReservation(active)
    });
  }

  #availableFor(phase: "work" | "final"): number {
    const activeReserved =
      this.#activeRequestId === null
        ? 0
        : this.#reservations.get(this.#activeRequestId)
            ?.reservedMicroUsd ?? 0;
    return Math.max(
      0,
      this.#policy.applicationCeilingMicroUsd -
        this.#settledMicroUsd -
        activeReserved -
        (phase === "work"
          ? this.#policy.finalAnswerReserveMicroUsd
          : 0)
    );
  }

  #responseLimitReached(phase: "work" | "final"): boolean {
    const dispatchLimit =
      phase === "work"
        ? this.#policy.maxResponses - 1
        : this.#policy.maxResponses;
    return this.#responsesStarted >= dispatchLimit;
  }

  #assertSha256(value: string, label: string): void {
    assertGovernor(
      typeof value === "string" && SHA256_PATTERN.test(value),
      "INVALID_ARGUMENT",
      `${label} must be a lowercase SHA-256 digest.`
    );
  }

  #assertRequestBinding(binding: RequestBinding): void {
    assertGovernor(
      typeof binding === "object" && binding !== null,
      "INVALID_ARGUMENT",
      "A request binding is required."
    );
    this.#assertSha256(binding.contextSha256, "contextSha256");
    assertGovernor(
      binding.model === this.#pricingIdentity.model,
      "RATE_CARD_MISMATCH",
      "The request model does not match the reserved rate card."
    );
    assertGovernor(
      binding.serviceTier ===
        this.#pricingIdentity.requestServiceTier,
      "RATE_CARD_MISMATCH",
      "The request service tier does not match the reserved rate card."
    );
    assertGovernor(
      binding.processingRegion ===
        this.#pricingIdentity.processingRegion,
      "RATE_CARD_MISMATCH",
      "The request processing region does not match the reserved rate card."
    );
  }

  #requireActive(
    requestId: string,
    allowedStatuses: readonly ReservationStatus[]
  ): MutableReservation {
    const reservation = this.#reservations.get(requestId);
    assertGovernor(
      reservation !== undefined,
      "RESERVATION_NOT_FOUND",
      `Reservation ${requestId} does not exist.`
    );
    assertGovernor(
      this.#activeRequestId === requestId &&
        allowedStatuses.includes(reservation.status),
      "INVALID_TRANSITION",
      `Reservation ${requestId} cannot transition from ${reservation.status}.`
    );
    return reservation;
  }

  #settleReservation(
    reservation: MutableReservation,
    usage: ProviderUsage,
    evidence: ProviderResponseEvidence,
    terminalReasonOverride?: "cancelled_with_usage"
  ): RequestReservation {
    this.#assertProviderEvidence(reservation, evidence);
    assertGovernor(
      !this.#settledProviderResponseIds.has(evidence.id),
      "INVALID_USAGE",
      `Provider response ${evidence.id} has already been settled.`
    );
    const normalizedUsage = normalizeProviderUsage(usage);
    assertGovernor(
      normalizedUsage.inputTokens === reservation.exactInputTokens,
      "RESERVATION_BREACH",
      "Provider input usage does not match the exact preflight count."
    );
    assertGovernor(
      normalizedUsage.outputTokens <= reservation.maxOutputTokens,
      "RESERVATION_BREACH",
      "Provider output usage exceeds the reserved output cap."
    );
    const settledCost = calculateUsageCost(
      this.#rateCard,
      usage
    ).totalMicroUsd;
    assertGovernor(
      settledCost <= reservation.reservedMicroUsd,
      "RESERVATION_BREACH",
      "Settled cost exceeds the request reservation."
    );
    const cumulative = safeIntegerFromBigInt(
      BigInt(this.#settledMicroUsd) + BigInt(settledCost),
      "Cumulative settled cost"
    );
    assertGovernor(
      cumulative <= this.#policy.applicationCeilingMicroUsd,
      "RESERVATION_BREACH",
      "Settlement would exceed the application ceiling."
    );

    this.#settledProviderResponseIds.add(evidence.id);
    reservation.status = "settled";
    reservation.settledMicroUsd = settledCost;
    reservation.usage = normalizedUsage;
    reservation.providerResponse = Object.freeze({ ...evidence });
    reservation.terminalReason =
      terminalReasonOverride ?? this.#terminalReasonFor(evidence.status);
    reservation.ambiguity = undefined;
    this.#settledMicroUsd = cumulative;
    this.#activeRequestId = null;
    if (reservation.phase === "final" && evidence.status === "completed") {
      this.#pendingFinalValidationRequestId = reservation.requestId;
    }
    return snapshotReservation(reservation);
  }

  #assertProviderEvidence(
    reservation: MutableReservation,
    evidence: ProviderResponseEvidence
  ): void {
    requireNonEmptyString(evidence.id, "provider response id");
    requireNonEmptyString(evidence.model, "provider response model");
    assertGovernor(
      evidence.status === "completed" ||
        evidence.status === "failed" ||
        evidence.status === "incomplete" ||
        evidence.status === "cancelled",
      "INVALID_USAGE",
      "Provider response status is not terminal."
    );
    assertGovernor(
      reservation.requestSha256 !== undefined,
      "INVALID_TRANSITION",
      "A dispatched request fingerprint is required before settlement."
    );
    assertGovernor(
      evidence.model === reservation.pricingIdentity.model,
      "RATE_CARD_MISMATCH",
      "The provider response model does not match the reserved rate card."
    );
    assertGovernor(
      evidence.serviceTier ===
        reservation.pricingIdentity.requestServiceTier,
      "RATE_CARD_MISMATCH",
      "The provider response service tier does not match the reserved rate card."
    );
  }

  #terminalReasonFor(
    status: ProviderTerminalStatus
  ): ReservationTerminalReason {
    switch (status) {
      case "completed":
        return "provider_completed";
      case "failed":
        return "provider_failed";
      case "incomplete":
        return "provider_incomplete";
      case "cancelled":
        return "provider_cancelled";
    }
  }

  #releaseReservation(
    reservation: MutableReservation,
    terminalReason:
      | "cancelled_before_dispatch"
      | "released_before_dispatch"
  ): RequestReservation {
    reservation.status = "released";
    reservation.terminalReason = terminalReason;
    reservation.ambiguity = undefined;
    this.#activeRequestId = null;
    return snapshotReservation(reservation);
  }
}
