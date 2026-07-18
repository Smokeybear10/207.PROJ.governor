import { createHash } from "node:crypto";
import {
  assertGovernor,
  requireNonEmptyString,
  requireNonNegativeSafeInteger
} from "./errors.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface RetryAttempt {
  readonly toolName: string;
  readonly arguments: JsonValue;
  readonly errorClass: string;
  readonly stateRevision: string;
  readonly transient?: boolean;
}

export type RetryState =
  | "FIRST_FAILURE"
  | "EQUIVALENT_RETRY"
  | "LIMIT_REACHED"
  | "MATERIAL_CHANGE"
  | "TRANSIENT_FAILURE";

export interface RetryObservation {
  readonly state: RetryState;
  readonly fingerprint: string;
  readonly baseFingerprint: string;
  readonly equivalentRetryCount: number;
  readonly occurrencesForFingerprint: number;
  readonly retryAllowed: boolean;
}

function canonicalJson(value: JsonValue, seen: Set<object>): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    assertGovernor(
      Number.isFinite(value),
      "INVALID_ARGUMENT",
      "Retry arguments cannot contain non-finite numbers."
    );
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }

  assertGovernor(
    typeof value === "object",
    "INVALID_ARGUMENT",
    "Retry arguments must be JSON values."
  );
  assertGovernor(
    !seen.has(value),
    "INVALID_ARGUMENT",
    "Retry arguments cannot contain cycles."
  );
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    }
    const objectValue = value as {
      readonly [key: string]: JsonValue;
    };
    const prototype = Object.getPrototypeOf(objectValue);
    assertGovernor(
      prototype === Object.prototype || prototype === null,
      "INVALID_ARGUMENT",
      "Retry argument objects must be plain JSON objects."
    );
    return `{${Object.keys(objectValue)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            objectValue[key],
            seen
          )}`
      )
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalizeRetryArguments(value: JsonValue): string {
  return canonicalJson(value, new Set());
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizedAttempt(attempt: RetryAttempt): {
  toolName: string;
  arguments: string;
  errorClass: string;
  stateRevision: string;
} {
  return {
    toolName: requireNonEmptyString(
      attempt.toolName,
      "toolName"
    )
      .trim()
      .toLowerCase(),
    arguments: canonicalizeRetryArguments(attempt.arguments),
    errorClass: requireNonEmptyString(
      attempt.errorClass,
      "errorClass"
    )
      .trim()
      .toLowerCase(),
    stateRevision: requireNonEmptyString(
      attempt.stateRevision,
      "stateRevision"
    ).trim()
  };
}

export function createRetryFingerprint(attempt: RetryAttempt): {
  readonly fingerprint: string;
  readonly baseFingerprint: string;
} {
  const normalized = normalizedAttempt(attempt);
  const base = JSON.stringify({
    toolName: normalized.toolName,
    arguments: normalized.arguments,
    errorClass: normalized.errorClass
  });
  const full = JSON.stringify({
    base,
    stateRevision: normalized.stateRevision
  });
  return Object.freeze({
    fingerprint: digest(full),
    baseFingerprint: digest(base)
  });
}

export class RetryFingerprintTracker {
  readonly #maxEquivalentRetries: number;
  readonly #occurrences = new Map<string, number>();
  readonly #seenBaseFingerprints = new Set<string>();

  constructor(maxEquivalentRetries: number) {
    this.#maxEquivalentRetries = requireNonNegativeSafeInteger(
      maxEquivalentRetries,
      "maxEquivalentRetries"
    );
  }

  observe(attempt: RetryAttempt): RetryObservation {
    const { fingerprint, baseFingerprint } =
      createRetryFingerprint(attempt);

    if (attempt.transient === true) {
      return Object.freeze({
        state: "TRANSIENT_FAILURE" as const,
        fingerprint,
        baseFingerprint,
        equivalentRetryCount: 0,
        occurrencesForFingerprint: 0,
        retryAllowed: true
      });
    }

    const priorOccurrences = this.#occurrences.get(fingerprint) ?? 0;
    const occurrencesForFingerprint = priorOccurrences + 1;
    this.#occurrences.set(fingerprint, occurrencesForFingerprint);
    const equivalentRetryCount = occurrencesForFingerprint - 1;
    const materialChange =
      priorOccurrences === 0 &&
      this.#seenBaseFingerprints.has(baseFingerprint);
    this.#seenBaseFingerprints.add(baseFingerprint);

    let state: RetryState;
    if (priorOccurrences === 0) {
      state = materialChange ? "MATERIAL_CHANGE" : "FIRST_FAILURE";
    } else if (
      equivalentRetryCount >= this.#maxEquivalentRetries
    ) {
      state = "LIMIT_REACHED";
    } else {
      state = "EQUIVALENT_RETRY";
    }

    return Object.freeze({
      state,
      fingerprint,
      baseFingerprint,
      equivalentRetryCount,
      occurrencesForFingerprint,
      retryAllowed:
        equivalentRetryCount < this.#maxEquivalentRetries
    });
  }
}
