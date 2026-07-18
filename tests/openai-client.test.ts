import { describe, expect, it, vi } from "vitest";
import {
  OpenAiApiError,
  OpenAiResponsesClient,
  type GovernedResponseRequest
} from "../server/openai/index.js";
import { MAX_OPENAI_RESPONSE_BODY_BYTES } from "../server/openai/responses-client.js";

const governedRequest: GovernedResponseRequest = {
  model: "gpt-5.4-mini",
  instructions: "Review the change.",
  input: [{ role: "user", content: "Inspect the diff." }],
  tools: [
    {
      type: "function",
      name: "read_file",
      parameters: { type: "object", properties: {} }
    }
  ],
  service_tier: "default",
  include: ["reasoning.encrypted_content"],
  max_output_tokens: 900,
  parallel_tool_calls: false,
  store: false,
  truncation: "disabled"
};

function jsonResponse(
  body: unknown,
  init: ResponseInit = { status: 200 }
): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-request-id": "req_test",
      ...init.headers
    }
  });
}

function streamedResponse(
  chunks: Uint8Array | readonly Uint8Array[],
  init: ResponseInit = { status: 200 },
  close = false
): { response: Response; cancel: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn();
  const bodyChunks = chunks instanceof Uint8Array ? [chunks] : chunks;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of bodyChunks) {
        controller.enqueue(chunk);
      }
      if (close) {
        controller.close();
      }
    },
    cancel
  });

  return {
    response: new Response(stream, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "x-request-id": "req_stream",
        ...init.headers
      }
    }),
    cancel
  };
}

describe("OpenAiResponsesClient", () => {
  it("preflights the complete context with the input-token endpoint", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({
          object: "response.input_tokens",
          input_tokens: 321
        })
    );
    const client = new OpenAiResponsesClient({
      apiKey: "test-key",
      fetchImpl
    });
    const { max_output_tokens: _max, parallel_tool_calls: _parallel, ...rest } =
      governedRequest;
    const { store: _store, truncation: _truncation, ...context } = rest;

    await expect(client.countInput(context)).resolves.toBe(321);
    expect(fetchImpl).toHaveBeenCalledOnce();

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses/input_tokens");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(context);
  });

  it("normalizes terminal usage without double-counting reasoning tokens", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        id: "resp_test",
        model: "gpt-5.4-mini-2026-04-01",
        service_tier: "default",
        status: "completed",
        output: [],
        usage: {
          input_tokens: 1_000,
          input_tokens_details: {
            cached_tokens: 400,
            cache_write_tokens: 100
          },
          output_tokens: 250,
          output_tokens_details: { reasoning_tokens: 80 },
          total_tokens: 1_250
        }
      })
    );
    const client = new OpenAiResponsesClient({
      apiKey: "test-key",
      fetchImpl
    });

    const result = await client.createResponse(governedRequest);

    expect(result.model).toBe("gpt-5.4-mini");
    expect(result.providerModel).toBe(
      "gpt-5.4-mini-2026-04-01"
    );
    expect(result.usage).toEqual({
      inputTokens: 1_000,
      cachedInputTokens: 400,
      cacheWriteInputTokens: 100,
      outputTokens: 250,
      reasoningOutputTokens: 80,
      totalTokens: 1_250
    });
    expect(result.requestId).toBe("req_test");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "input partitions exceed input tokens",
      usage: {
        input_tokens: 10,
        input_tokens_details: {
          cached_tokens: 8,
          cache_write_tokens: 3
        },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 15
      }
    },
    {
      name: "reasoning tokens exceed output tokens",
      usage: {
        input_tokens: 10,
        input_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 0
        },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 6 },
        total_tokens: 15
      }
    },
    {
      name: "total tokens do not equal input plus output",
      usage: {
        input_tokens: 10,
        input_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 0
        },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 16
      }
    }
  ])("rejects usage when $name", async ({ usage }) => {
    const client = new OpenAiResponsesClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        jsonResponse({
          id: "resp_invalid_usage",
          model: "gpt-5.4-mini",
          service_tier: "default",
          status: "completed",
          output: [],
          usage
        })
    });

    const error = await client
      .createResponse(governedRequest)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenAiApiError);
    expect(error).toMatchObject({
      status: 200,
      ambiguous: true,
      protocolError: true,
      requestId: "req_test"
    });
  });

  it("marks model transport failures ambiguous and never retries", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("socket closed");
    });
    const client = new OpenAiResponsesClient({
      apiKey: "test-key",
      fetchImpl
    });

    const error = await client
      .createResponse(governedRequest)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenAiApiError);
    expect((error as OpenAiApiError).ambiguous).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("classifies definitive and ambiguous provider HTTP failures", async () => {
    for (const [status, ambiguous] of [
      [429, false],
      [408, true],
      [500, true]
    ] as const) {
      const client = new OpenAiResponsesClient({
        apiKey: "test-key",
        fetchImpl: async () =>
          jsonResponse(
            { error: { message: "provider failure" } },
            { status }
          )
      });

      const error = await client
        .createResponse(governedRequest)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(OpenAiApiError);
      expect(error).toMatchObject({
        status,
        requestId: "req_test",
        ambiguous
      });
    }
  });

  it("cancels oversized streamed create-response bodies and keeps the outcome ambiguous", async () => {
    const streamed = streamedResponse([
      new Uint8Array(MAX_OPENAI_RESPONSE_BODY_BYTES),
      new Uint8Array(1)
    ]);
    const fetchImpl = vi.fn(async () => streamed.response);
    const client = new OpenAiResponsesClient({
      apiKey: "test-key",
      fetchImpl
    });

    const error = await client
      .createResponse(governedRequest)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenAiApiError);
    expect(error).toMatchObject({
      ambiguous: true,
      requestId: "req_stream"
    });
    expect((error as Error).message).toContain("8 MiB");
    expect(streamed.cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("cancels oversized HTTP error bodies while preserving the known status", async () => {
    const streamed = streamedResponse(
      [
        new Uint8Array(MAX_OPENAI_RESPONSE_BODY_BYTES),
        new Uint8Array(1)
      ],
      { status: 429 }
    );
    const client = new OpenAiResponsesClient({
      apiKey: "test-key",
      fetchImpl: async () => streamed.response
    });

    const error = await client
      .createResponse(governedRequest)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenAiApiError);
    expect(error).toMatchObject({
      status: 429,
      requestId: "req_stream",
      ambiguous: false
    });
    expect((error as Error).message).toContain("error body exceeded");
    expect(streamed.cancel).toHaveBeenCalledOnce();
  });

  it("rejects invalid UTF-8 as a controlled ambiguous create-response error", async () => {
    const streamed = streamedResponse(new Uint8Array([0xff]), undefined, true);
    const client = new OpenAiResponsesClient({
      apiKey: "test-key",
      fetchImpl: async () => streamed.response
    });

    const error = await client
      .createResponse(governedRequest)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenAiApiError);
    expect(error).toMatchObject({
      ambiguous: true,
      requestId: "req_stream"
    });
    expect((error as Error).message).toContain("not valid UTF-8");
  });

  it("marks malformed successful create-response envelopes ambiguous", async () => {
    const client = new OpenAiResponsesClient({
      apiKey: "test-key",
      fetchImpl: async () => jsonResponse({ id: "missing-fields" })
    });

    const error = await client
      .createResponse(governedRequest)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenAiApiError);
    expect(error).toMatchObject({
      ambiguous: true,
      requestId: "req_test"
    });
    expect((error as Error).message).toContain(
      "invalid response envelope"
    );
  });

  it("treats preflight transport failures as uncharged", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("offline");
    });
    const client = new OpenAiResponsesClient({
      apiKey: "test-key",
      fetchImpl
    });

    const error = await client
      .countInput({ model: "gpt-5.4-mini", input: "Review this." })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenAiApiError);
    expect((error as OpenAiApiError).ambiguous).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects hosted and MCP tools before dispatch", async () => {
    const fetchImpl = vi.fn();
    const client = new OpenAiResponsesClient({
      apiKey: "test-key",
      fetchImpl
    });

    await expect(
      client.createResponse({
        ...governedRequest,
        tools: [{ type: "web_search" }]
      })
    ).rejects.toThrow("local function tools only");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects previous_response_id before dispatch", async () => {
    const fetchImpl = vi.fn();
    const client = new OpenAiResponsesClient({
      apiKey: "test-key",
      fetchImpl
    });

    await expect(
      client.createResponse({
        ...governedRequest,
        previous_response_id: "resp_previous"
      })
    ).rejects.toThrow("must not use previous_response_id");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves a successful response with missing usage for safe-stop handling", async () => {
    const client = new OpenAiResponsesClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        jsonResponse({
          id: "resp_no_usage",
          model: "gpt-5.4-mini",
          service_tier: "default",
          status: "completed",
          output: [],
          usage: null
        })
    });

    await expect(client.createResponse(governedRequest)).resolves.toMatchObject({
      id: "resp_no_usage",
      usage: null
    });
  });

  it("does not expose the API key through validation errors", () => {
    expect(
      () =>
        new OpenAiResponsesClient({
          apiKey: "secret-provider-key",
          timeoutMs: 0
        })
    ).toThrow("timeoutMs");

    try {
      new OpenAiResponsesClient({
        apiKey: "secret-provider-key",
        timeoutMs: 0
      });
    } catch (error) {
      expect(String(error)).not.toContain("secret-provider-key");
    }
  });
});
