// Pure, vscode-free client for the governor's CI-REPAIR layer. Keeping this
// module free of `import "vscode"` makes it unit-testable under plain Node
// (see repairClient.spec.ts) and reusable outside the extension host.

import {
  GovernorApiError,
  GovernorHttpClient
} from "./apiClient";

export { GovernorApiError } from "./apiClient";

export type RepairMode = "fake" | "hybrid" | "live";

export type RepairTraceEvent = {
  kind: string;
  sequence: number;
  name?: string;
  phase?: string;
  status?: string;
  state?: string;
};

export type RepairEvaluation = {
  passed: boolean;
  targetPassed: boolean;
  policyRespected: boolean;
  exitCode: number;
  violations: string[];
};

export type RepairResult = {
  status: "repaired" | "not_repaired";
  reason?: string;
  finalText: string | null;
  evaluation: RepairEvaluation | null;
  toolCalls: number;
  revision: string;
  settledMicroUsd: number;
  trace: RepairTraceEvent[];
};

export type RepairRunResponse = {
  fixtureId: string;
  mode: RepairMode;
  model: string;
  rateCardVersion: string;
  policy: unknown;
  result: RepairResult;
};

export type RepairHealth = {
  service: string;
  status: string;
  mode: string;
  providerConfigured: boolean;
  governedApi?: boolean;
};

export type RepairRunInput = {
  fixtureId?: string;
  mode?: RepairMode;
};

const DEFAULT_FIXTURE_ID = "broken-sum";
const DEFAULT_MODE: RepairMode = "fake";
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Formats an integer micro-USD amount as a dollar string with six fractional
 * digits, e.g. 1234 → "$0.001234". Returns "n/a" for undefined/invalid input.
 */
export function formatMicroUsd(microUsd: number | undefined): string {
  if (microUsd === undefined || microUsd === null || !Number.isFinite(microUsd)) {
    return "n/a";
  }
  const usd = microUsd / 1_000_000;
  return `$${usd.toFixed(6)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(message: string): never {
  throw new GovernorApiError(message, 200, "INVALID_RESPONSE");
}

function requireRecord(
  value: unknown,
  path: string
): Record<string, unknown> {
  if (!isRecord(value)) {
    invalidResponse(`Governor response field "${path}" must be an object.`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    invalidResponse(`Governor response field "${path}" must be a string.`);
  }
  return value;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidResponse(`Governor response field "${path}" must be a number.`);
  }
  return value;
}

function requireInteger(value: unknown, path: string): number {
  const number = requireNumber(value, path);
  if (!Number.isSafeInteger(number)) {
    invalidResponse(`Governor response field "${path}" must be an integer.`);
  }
  return number;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  const number = requireInteger(value, path);
  if (number < 0) {
    invalidResponse(
      `Governor response field "${path}" must be a non-negative integer.`
    );
  }
  return number;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    invalidResponse(`Governor response field "${path}" must be a boolean.`);
  }
  return value;
}

function optionalString(
  value: unknown,
  path: string
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, path);
}

function requireRepairMode(value: unknown, path: string): RepairMode {
  if (value !== "fake" && value !== "hybrid" && value !== "live") {
    invalidResponse(
      `Governor response field "${path}" must be "fake", "hybrid", or "live".`
    );
  }
  return value;
}

function parseTrace(value: unknown): RepairTraceEvent[] {
  if (!Array.isArray(value)) {
    invalidResponse('Governor response field "result.trace" must be an array.');
  }
  return value.map((rawEvent, index) => {
    const event = requireRecord(rawEvent, `result.trace[${index}]`);
    const normalized: RepairTraceEvent = {
      kind: requireString(event.kind, `result.trace[${index}].kind`),
      sequence: requireNonNegativeInteger(
        event.sequence,
        `result.trace[${index}].sequence`
      )
    };
    const name = optionalString(event.name, `result.trace[${index}].name`);
    const phase = optionalString(event.phase, `result.trace[${index}].phase`);
    const status = optionalString(
      event.status,
      `result.trace[${index}].status`
    );
    const state = optionalString(event.state, `result.trace[${index}].state`);
    if (name !== undefined) normalized.name = name;
    if (phase !== undefined) normalized.phase = phase;
    if (status !== undefined) normalized.status = status;
    if (state !== undefined) normalized.state = state;
    return normalized;
  });
}

function parseEvaluation(value: unknown): RepairEvaluation | null {
  if (value === null) {
    return null;
  }
  const evaluation = requireRecord(value, "result.evaluation");
  if (!Array.isArray(evaluation.violations)) {
    invalidResponse(
      'Governor response field "result.evaluation.violations" must be an array.'
    );
  }
  if (
    !evaluation.violations.every(
      (violation): violation is string => typeof violation === "string"
    )
  ) {
    invalidResponse(
      'Governor response field "result.evaluation.violations" must contain strings.'
    );
  }
  const violations = [...evaluation.violations];
  return {
    passed: requireBoolean(evaluation.passed, "result.evaluation.passed"),
    targetPassed: requireBoolean(
      evaluation.targetPassed,
      "result.evaluation.targetPassed"
    ),
    policyRespected: requireBoolean(
      evaluation.policyRespected,
      "result.evaluation.policyRespected"
    ),
    exitCode: requireInteger(
      evaluation.exitCode,
      "result.evaluation.exitCode"
    ),
    violations
  };
}

function parseResult(value: unknown): RepairResult {
  const record = requireRecord(value, "result");
  if (record.status !== "repaired" && record.status !== "not_repaired") {
    invalidResponse(
      'Governor response field "result.status" must be "repaired" or "not_repaired".'
    );
  }
  if (record.finalText !== null && typeof record.finalText !== "string") {
    invalidResponse(
      'Governor response field "result.finalText" must be a string or null.'
    );
  }
  const settledMicroUsd = requireNonNegativeInteger(
    record.settledMicroUsd,
    "result.settledMicroUsd"
  );
  const result: RepairResult = {
    status: record.status,
    finalText: record.finalText,
    evaluation: parseEvaluation(record.evaluation),
    toolCalls: requireNonNegativeInteger(record.toolCalls, "result.toolCalls"),
    revision: requireString(record.revision, "result.revision"),
    settledMicroUsd,
    trace: parseTrace(record.trace)
  };
  const reason = optionalString(record.reason, "result.reason");
  if (reason !== undefined) result.reason = reason;
  if (result.status === "repaired") {
    if (result.finalText === null || result.evaluation === null) {
      invalidResponse(
        "A repaired Governor result must include final text and an evaluation."
      );
    }
  } else if (!result.reason) {
    invalidResponse("A non-repaired Governor result must include a reason.");
  }
  return result;
}

function parseRunResponse(value: unknown): RepairRunResponse {
  const record = requireRecord(value, "response");
  requireRecord(record.policy, "policy");
  return {
    fixtureId: requireString(record.fixtureId, "fixtureId"),
    mode: requireRepairMode(record.mode, "mode"),
    model: requireString(record.model, "model"),
    rateCardVersion: requireString(record.rateCardVersion, "rateCardVersion"),
    policy: record.policy,
    result: parseResult(record.result)
  };
}

function parseHealth(value: unknown): RepairHealth {
  const record = requireRecord(value, "response");
  const health: RepairHealth = {
    service: requireString(record.service, "service"),
    status: requireString(record.status, "status"),
    mode: requireString(record.mode, "mode"),
    providerConfigured: requireBoolean(
      record.providerConfigured,
      "providerConfigured"
    )
  };
  if (record.governedApi !== undefined) {
    health.governedApi = requireBoolean(record.governedApi, "governedApi");
  }
  return health;
}

export class RepairClient {
  readonly #http: GovernorHttpClient;

  constructor(opts: { baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.#http = new GovernorHttpClient({
      baseUrl: opts.baseUrl,
      ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    });
  }

  async runRepair(
    input?: RepairRunInput,
    signal?: AbortSignal
  ): Promise<RepairRunResponse> {
    const body = {
      fixtureId: input?.fixtureId ?? DEFAULT_FIXTURE_ID,
      mode: input?.mode ?? DEFAULT_MODE
    };
    const payload = await this.#http.request(
      "/api/repair/runs",
      {
        method: "POST",
        body: JSON.stringify(body)
      },
      signal
    );
    return parseRunResponse(payload);
  }

  async health(signal?: AbortSignal): Promise<RepairHealth> {
    const payload = await this.#http.request(
      "/api/health",
      { method: "GET" },
      signal
    );
    return parseHealth(payload);
  }
}
