const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 65_000;

// Governed responses are token-capped; 8 MiB leaves substantial envelope
// headroom while bounding memory used for provider-controlled JSON bodies.
export const MAX_OPENAI_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type JsonObject = Record<string, unknown>;

export type ResponseContext = {
  model: string;
  input: unknown;
  instructions?: string;
  tools?: JsonObject[];
  previous_response_id?: string;
  service_tier?: "default";
};

export type GovernedResponseRequest = Omit<ResponseContext, "service_tier"> & {
  service_tier: "default";
  include: ["reasoning.encrypted_content"];
  max_output_tokens: number;
  parallel_tool_calls: false;
  store: false;
  truncation: "disabled";
};

export type ResponseStatus =
  | "completed"
  | "failed"
  | "incomplete"
  | "cancelled"
  | "queued"
  | "in_progress";

export type ProviderUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type TerminalResponse = {
  id: string;
  model: string;
  serviceTier: "default";
  status: ResponseStatus;
  output: unknown[];
  usage: ProviderUsage | null;
  requestId?: string;
};

export class OpenAiApiError extends Error {
  readonly status: number;
  readonly requestId?: string;
  readonly ambiguous: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      requestId?: string;
      ambiguous?: boolean;
      cause?: unknown;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "OpenAiApiError";
    this.status = options.status ?? 0;
    this.requestId = options.requestId;
    this.ambiguous = options.ambiguous ?? false;
  }
}

export type OpenAiResponsesClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

type ResponseBodyErrorKind =
  | "too_large"
  | "read_failed"
  | "invalid_utf8"
  | "invalid_json";

class ResponseBodyError extends Error {
  readonly kind: ResponseBodyErrorKind;

  constructor(kind: ResponseBodyErrorKind, cause?: unknown) {
    super(kind, { cause });
    this.name = "ResponseBodyError";
    this.kind = kind;
  }
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OpenAiApiError(`OpenAI returned an invalid ${field}.`);
  }
  return value as number;
}

function normalizeUsage(value: unknown): ProviderUsage | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "object") {
    throw new OpenAiApiError("OpenAI returned invalid usage data.");
  }

  const usage = value as JsonObject;
  const inputDetails =
    typeof usage.input_tokens_details === "object" &&
    usage.input_tokens_details !== null
      ? (usage.input_tokens_details as JsonObject)
      : {};
  const outputDetails =
    typeof usage.output_tokens_details === "object" &&
    usage.output_tokens_details !== null
      ? (usage.output_tokens_details as JsonObject)
      : {};

  return {
    inputTokens: requireNonNegativeInteger(
      usage.input_tokens,
      "usage.input_tokens"
    ),
    cachedInputTokens: requireNonNegativeInteger(
      inputDetails.cached_tokens ?? 0,
      "usage.input_tokens_details.cached_tokens"
    ),
    cacheWriteInputTokens: requireNonNegativeInteger(
      inputDetails.cache_write_tokens ?? 0,
      "usage.input_tokens_details.cache_write_tokens"
    ),
    outputTokens: requireNonNegativeInteger(
      usage.output_tokens,
      "usage.output_tokens"
    ),
    reasoningOutputTokens: requireNonNegativeInteger(
      outputDetails.reasoning_tokens ?? 0,
      "usage.output_tokens_details.reasoning_tokens"
    ),
    totalTokens: requireNonNegativeInteger(
      usage.total_tokens,
      "usage.total_tokens"
    )
  };
}

function normalizeStatus(value: unknown): ResponseStatus {
  if (
    value !== "completed" &&
    value !== "failed" &&
    value !== "incomplete" &&
    value !== "cancelled" &&
    value !== "queued" &&
    value !== "in_progress"
  ) {
    throw new OpenAiApiError("OpenAI returned an unknown response status.");
  }
  return value;
}

function assertContext(context: ResponseContext): void {
  if (!context.model.trim()) {
    throw new OpenAiApiError("A model is required.");
  }
  if (context.input === undefined) {
    throw new OpenAiApiError("Response input is required.");
  }

  for (const tool of context.tools ?? []) {
    if (tool.type !== "function") {
      throw new OpenAiApiError(
        "The governed runtime permits local function tools only."
      );
    }
  }
}

function assertGovernedRequest(request: GovernedResponseRequest): void {
  assertContext(request);
  if (
    !Number.isSafeInteger(request.max_output_tokens) ||
    request.max_output_tokens < 1
  ) {
    throw new OpenAiApiError(
      "max_output_tokens must be a positive safe integer."
    );
  }
  if (
    request.parallel_tool_calls !== false ||
    request.store !== false ||
    request.truncation !== "disabled" ||
    request.service_tier !== "default" ||
    !Array.isArray(request.include) ||
    request.include.length !== 1 ||
    request.include[0] !== "reasoning.encrypted_content"
  ) {
    throw new OpenAiApiError(
      "Governed responses must preserve stateless reasoning, use the default tier, and disable parallel tools, storage, and truncation."
    );
  }
}

function combineSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readLimitedJsonBody(response: Response): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  if (response.body !== null) {
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = response.body.getReader();
    } catch (error) {
      throw new ResponseBodyError("read_failed", error);
    }

    try {
      while (true) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (error) {
          throw new ResponseBodyError("read_failed", error);
        }
        if (result.done) {
          break;
        }

        const chunk = result.value;
        if (
          chunk.byteLength >
          MAX_OPENAI_RESPONSE_BODY_BYTES - totalBytes
        ) {
          try {
            await reader.cancel();
          } catch {
            // The size violation is the controlled error surfaced to callers.
          }
          throw new ResponseBodyError("too_large");
        }
        totalBytes += chunk.byteLength;
        chunks.push(chunk);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A failed release cannot make an otherwise bounded body ambiguous.
      }
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ResponseBodyError("invalid_utf8", error);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ResponseBodyError("invalid_json", error);
  }
}

function responseBodyErrorMessage(error: ResponseBodyError): string {
  switch (error.kind) {
    case "too_large":
      return "OpenAI response body exceeded the 8 MiB limit.";
    case "invalid_utf8":
      return "OpenAI returned a response body that is not valid UTF-8.";
    case "invalid_json":
      return "OpenAI returned a response body that is not valid JSON.";
    case "read_failed":
      return "OpenAI response body could not be read.";
  }
}

function protocolErrorFromResponse(
  response: Response,
  error: unknown,
  ambiguous: boolean
): OpenAiApiError {
  const message =
    error instanceof ResponseBodyError
      ? responseBodyErrorMessage(error)
      : error instanceof OpenAiApiError
        ? error.message
        : "OpenAI returned an invalid response body.";

  return new OpenAiApiError(message, {
    requestId: response.headers.get("x-request-id") ?? undefined,
    ambiguous,
    cause: error
  });
}

function requireJsonObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpenAiApiError(`OpenAI returned an invalid ${label} envelope.`);
  }
  return value as JsonObject;
}

async function errorFromResponse(response: Response): Promise<OpenAiApiError> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  let providerMessage = "";

  try {
    const value = await readLimitedJsonBody(response);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const error = (value as JsonObject).error;
      if (
        typeof error === "object" &&
        error !== null &&
        !Array.isArray(error) &&
        typeof (error as JsonObject).message === "string"
      ) {
        providerMessage = (error as JsonObject).message as string;
      }
    }
  } catch (error) {
    if (error instanceof ResponseBodyError && error.kind === "too_large") {
      return new OpenAiApiError(
        `OpenAI request failed with status ${response.status}; the error body exceeded the 8 MiB limit.`,
        { status: response.status, requestId, cause: error }
      );
    }
    // The HTTP status remains useful when the provider body is not JSON.
    return new OpenAiApiError(
      `OpenAI request failed with status ${response.status}.`,
      { status: response.status, requestId, cause: error }
    );
  }

  return new OpenAiApiError(
    providerMessage || `OpenAI request failed with status ${response.status}.`,
    { status: response.status, requestId }
  );
}

export class OpenAiResponsesClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: OpenAiResponsesClientOptions) {
    if (!options.apiKey.trim()) {
      throw new OpenAiApiError("OPENAI_API_KEY is not configured.");
    }
    if (
      !Number.isSafeInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) ||
      (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) < 1
    ) {
      throw new OpenAiApiError("timeoutMs must be a positive safe integer.");
    }

    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async countInput(
    context: ResponseContext,
    signal?: AbortSignal
  ): Promise<number> {
    assertContext(context);
    const response = await this.#post(
      "/responses/input_tokens",
      context,
      false,
      signal
    );
    try {
      const body = requireJsonObject(
        await readLimitedJsonBody(response),
        "input-token response"
      );
      return requireNonNegativeInteger(body.input_tokens, "input_tokens");
    } catch (error) {
      throw protocolErrorFromResponse(response, error, false);
    }
  }

  async createResponse(
    request: GovernedResponseRequest,
    signal?: AbortSignal
  ): Promise<TerminalResponse> {
    assertGovernedRequest(request);
    const response = await this.#post("/responses", request, true, signal);
    try {
      const body = requireJsonObject(
        await readLimitedJsonBody(response),
        "response"
      );

      if (
        typeof body.id !== "string" ||
        typeof body.model !== "string" ||
        body.service_tier !== "default" ||
        !Array.isArray(body.output)
      ) {
        throw new OpenAiApiError(
          "OpenAI returned an invalid response envelope."
        );
      }

      return {
        id: body.id,
        model: body.model,
        serviceTier: "default",
        status: normalizeStatus(body.status),
        output: body.output,
        usage: normalizeUsage(body.usage),
        requestId: response.headers.get("x-request-id") ?? undefined
      };
    } catch (error) {
      throw protocolErrorFromResponse(response, error, true);
    }
  }

  async #post(
    path: string,
    body: unknown,
    ambiguousOnTransportFailure: boolean,
    signal?: AbortSignal
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: combineSignal(signal, this.#timeoutMs)
      });
    } catch (error) {
      throw new OpenAiApiError(
        ambiguousOnTransportFailure
          ? "The model request outcome is ambiguous and must be reconciled."
          : "The input-token preflight could not be completed.",
        {
          ambiguous: ambiguousOnTransportFailure,
          cause: error
        }
      );
    }

    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    return response;
  }
}
