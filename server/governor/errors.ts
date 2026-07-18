export type GovernorErrorCode =
  | "COST_OVERFLOW"
  | "INVALID_ARGUMENT"
  | "INVALID_RATE_CARD"
  | "INVALID_TRANSITION"
  | "INVALID_USAGE"
  | "RATE_CARD_MISMATCH"
  | "RESERVATION_BREACH"
  | "RESERVATION_NOT_FOUND";

export class GovernorError extends Error {
  readonly code: GovernorErrorCode;

  constructor(code: GovernorErrorCode, message: string) {
    super(message);
    this.name = "GovernorError";
    this.code = code;
  }
}

export function assertGovernor(
  condition: unknown,
  code: GovernorErrorCode,
  message: string
): asserts condition {
  if (!condition) {
    throw new GovernorError(code, message);
  }
}

export function requireNonNegativeSafeInteger(
  value: number,
  label: string,
  code: GovernorErrorCode = "INVALID_ARGUMENT"
): number {
  assertGovernor(
    Number.isSafeInteger(value) && value >= 0,
    code,
    `${label} must be a non-negative safe integer.`
  );
  return value;
}

export function requirePositiveSafeInteger(
  value: number,
  label: string,
  code: GovernorErrorCode = "INVALID_ARGUMENT"
): number {
  assertGovernor(
    Number.isSafeInteger(value) && value > 0,
    code,
    `${label} must be a positive safe integer.`
  );
  return value;
}

export function requireNonEmptyString(
  value: string,
  label: string,
  code: GovernorErrorCode = "INVALID_ARGUMENT"
): string {
  assertGovernor(
    typeof value === "string" && value.trim().length > 0,
    code,
    `${label} must be a non-empty string.`
  );
  return value;
}

export function safeIntegerFromBigInt(
  value: bigint,
  label: string,
  code: GovernorErrorCode = "COST_OVERFLOW"
): number {
  assertGovernor(
    value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER),
    code,
    `${label} exceeds the safe integer range.`
  );
  return Number(value);
}
