const DEFAULT_TIMEOUT_MS = 70_000;

export class GovernorApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "GovernorApiError";
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GovernorApiError(
      "Governor API URL must be a valid HTTP or HTTPS URL.",
      0,
      "INVALID_BASE_URL"
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new GovernorApiError(
      "Governor API URL must use HTTP or HTTPS without credentials, a query, or a fragment.",
      0,
      "INVALID_BASE_URL"
    );
  }
  return url.toString().replace(/\/+$/, "");
}

export class GovernorHttpClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly baseUrl: string;
    readonly fetchImpl?: typeof fetch;
    readonly timeoutMs?: number;
  }) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new GovernorApiError(
        "Governor request timeout must be a positive integer.",
        0,
        "INVALID_TIMEOUT"
      );
    }
  }

  async request(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal
  ): Promise<unknown> {
    if (!path.startsWith("/")) {
      throw new GovernorApiError(
        "Governor API request paths must start with '/'.",
        0,
        "INVALID_REQUEST_PATH"
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    timeout.unref?.();

    const cancel = (): void => controller.abort();
    if (signal?.aborted) {
      cancel();
    } else {
      signal?.addEventListener("abort", cancel, { once: true });
    }

    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers
        }
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        if (response.ok) {
          throw new GovernorApiError(
            "Governor returned a successful response that was not valid JSON.",
            response.status,
            "INVALID_RESPONSE"
          );
        }
        body = {};
      }

      if (!response.ok) {
        const envelope = isRecord(body) ? body.error : undefined;
        const code =
          isRecord(envelope) && typeof envelope.code === "string"
            ? envelope.code
            : `HTTP_${response.status}`;
        const message =
          isRecord(envelope) && typeof envelope.message === "string"
            ? envelope.message
            : `Request failed with HTTP ${response.status}.`;
        throw new GovernorApiError(message, response.status, code);
      }
      return body;
    } catch (error) {
      if (signal?.aborted) {
        throw new GovernorApiError(
          "The Governor request was cancelled.",
          0,
          "CANCELLED"
        );
      }
      if (timedOut) {
        throw new GovernorApiError(
          `Governor did not respond within ${this.#timeoutMs} ms.`,
          0,
          "TIMEOUT"
        );
      }
      if (error instanceof GovernorApiError) {
        throw error;
      }
      throw new GovernorApiError(
        `Could not reach the Governor at ${this.#baseUrl}.`,
        0,
        "NETWORK_ERROR"
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    }
  }
}
