import { describe, expect, it, vi } from "vitest";

import {
  GovernorApiError,
  GovernorHttpClient,
  normalizeBaseUrl
} from "./apiClient";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

describe("normalizeBaseUrl", () => {
  it("normalizes supported HTTP URLs", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787"
    );
    expect(normalizeBaseUrl("https://governor.example/api/")).toBe(
      "https://governor.example/api"
    );
  });

  it.each([
    "not a url",
    "file:///tmp/governor",
    "http://user:secret@localhost:8787",
    "http://localhost:8787?debug=1",
    "http://localhost:8787/#fragment"
  ])("rejects unsupported API URL %s", (value) => {
    expect(() => normalizeBaseUrl(value)).toThrowError(
      expect.objectContaining({ code: "INVALID_BASE_URL" })
    );
  });
});

describe("GovernorHttpClient", () => {
  it("sends JSON headers and returns a successful payload", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: "ready" }));
    const client = new GovernorHttpClient({
      baseUrl: "http://127.0.0.1:8787/",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(
      client.request("/api/health", { method: "GET" })
    ).resolves.toEqual({ status: "ready" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/health",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" })
      })
    );
  });

  it("preserves a structured server error", async () => {
    const client = new GovernorHttpClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: vi.fn(async () =>
        jsonResponse(404, {
          error: { code: "JOB_NOT_FOUND", message: "job is gone" }
        })
      ) as unknown as typeof fetch
    });

    await expect(client.request("/v1/jobs/missing")).rejects.toMatchObject({
      name: "GovernorApiError",
      status: 404,
      code: "JOB_NOT_FOUND",
      message: "job is gone"
    });
  });

  it("classifies timeouts separately from network failures", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true }
          );
        })
    );
    const client = new GovernorHttpClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5
    });

    await expect(client.request("/api/health")).rejects.toMatchObject({
      code: "TIMEOUT"
    });
  });

  it("classifies caller cancellation and removes its listener", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true }
          );
        })
    );
    const client = new GovernorHttpClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const request = client.request("/api/health", {}, controller.signal);
    controller.abort();

    await expect(request).rejects.toMatchObject({ code: "CANCELLED" });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("rejects malformed successful JSON responses", async () => {
    const client = new GovernorHttpClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("invalid JSON");
        }
      })) as unknown as typeof fetch
    });

    await expect(client.request("/api/health")).rejects.toEqual(
      new GovernorApiError(
        "Governor returned a successful response that was not valid JSON.",
        200,
        "INVALID_RESPONSE"
      )
    );
  });
});
