// Pure, vscode-free client for the governor's CI-REPAIR layer. Keeping this
// module free of `import "vscode"` makes it unit-testable under plain Node
// (see repairClient.spec.ts) and reusable outside the extension host.

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
  settledMicroUsd?: number;
  trace: RepairTraceEvent[];
};

export type RepairRunResponse = {
  fixtureId: string;
  mode: string;
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

// Mirrors the server's `{ error: { code, message } }` envelope. Defined locally
// (rather than imported) so this module stays dependency-free and vscode-free.
export class GovernorApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "GovernorApiError";
    this.status = status;
    this.code = code;
  }
}

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
  return typeof value === "object" && value !== null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeTrace(value: unknown): RepairTraceEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isRecord)
    .map((event, index) => {
      const normalized: RepairTraceEvent = {
        kind: asString(event.kind, "event"),
        sequence: asNumber(event.sequence, index)
      };
      if (typeof event.name === "string") normalized.name = event.name;
      if (typeof event.phase === "string") normalized.phase = event.phase;
      if (typeof event.status === "string") normalized.status = event.status;
      if (typeof event.state === "string") normalized.state = event.state;
      return normalized;
    });
}

function normalizeEvaluation(value: unknown): RepairEvaluation | null {
  if (!isRecord(value)) {
    return null;
  }
  const violations = Array.isArray(value.violations)
    ? value.violations.filter((v): v is string => typeof v === "string")
    : [];
  return {
    passed: asBoolean(value.passed),
    targetPassed: asBoolean(value.targetPassed),
    policyRespected: asBoolean(value.policyRespected),
    exitCode: asNumber(value.exitCode),
    violations
  };
}

function normalizeResult(value: unknown): RepairResult {
  const record = isRecord(value) ? value : {};
  const status: RepairResult["status"] =
    record.status === "repaired" ? "repaired" : "not_repaired";
  const result: RepairResult = {
    status,
    finalText: typeof record.finalText === "string" ? record.finalText : null,
    evaluation: normalizeEvaluation(record.evaluation),
    toolCalls: asNumber(record.toolCalls),
    revision: asString(record.revision),
    trace: normalizeTrace(record.trace)
  };
  if (typeof record.reason === "string") {
    result.reason = record.reason;
  }
  if (typeof record.settledMicroUsd === "number" && Number.isFinite(record.settledMicroUsd)) {
    result.settledMicroUsd = record.settledMicroUsd;
  }
  return result;
}

function normalizeRunResponse(value: unknown): RepairRunResponse {
  const record = isRecord(value) ? value : {};
  return {
    fixtureId: asString(record.fixtureId, DEFAULT_FIXTURE_ID),
    mode: asString(record.mode, DEFAULT_MODE),
    model: asString(record.model),
    rateCardVersion: asString(record.rateCardVersion),
    policy: record.policy,
    result: normalizeResult(record.result)
  };
}

function normalizeHealth(value: unknown): RepairHealth {
  const record = isRecord(value) ? value : {};
  const health: RepairHealth = {
    service: asString(record.service),
    status: asString(record.status),
    mode: asString(record.mode),
    providerConfigured: asBoolean(record.providerConfigured)
  };
  if (typeof record.governedApi === "boolean") {
    health.governedApi = record.governedApi;
  }
  return health;
}

export class RepairClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: { baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async runRepair(
    input?: RepairRunInput,
    signal?: AbortSignal
  ): Promise<RepairRunResponse> {
    const body = {
      fixtureId: input?.fixtureId ?? DEFAULT_FIXTURE_ID,
      mode: input?.mode ?? DEFAULT_MODE
    };
    const payload = await this.#request(
      "/api/repair/runs",
      {
        method: "POST",
        body: JSON.stringify(body)
      },
      signal
    );
    return normalizeRunResponse(payload);
  }

  async health(signal?: AbortSignal): Promise<RepairHealth> {
    const payload = await this.#request("/api/health", { method: "GET" }, signal);
    return normalizeHealth(payload);
  }

  async #request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers
        }
      });
    } catch (error) {
      throw new GovernorApiError(
        `Could not reach the governor at ${this.#baseUrl}. Is the server running?`,
        0,
        "NETWORK_ERROR"
      );
    } finally {
      clearTimeout(timeout);
    }

    const raw = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) {
      const envelope = isRecord(raw) ? raw.error : undefined;
      const code = isRecord(envelope) ? asString(envelope.code) || undefined : undefined;
      const message = isRecord(envelope)
        ? asString(envelope.message) || `Request failed with HTTP ${response.status}.`
        : `Request failed with HTTP ${response.status}.`;
      throw new GovernorApiError(message, response.status, code);
    }
    return raw;
  }
}
