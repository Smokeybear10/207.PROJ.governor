import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { OpenAiApiError } from "../server/openai/index.js";
import type {
  GovernedResponseRequest,
  TerminalResponse
} from "../server/openai/index.js";
import type { ResponsesProvider } from "../server/runtime/index.js";

const servers: Server[] = [];

type StartedApp = {
  readonly baseUrl: string;
  readonly requests: GovernedResponseRequest[];
};

async function startApp(
  provider?: ResponsesProvider | null
): Promise<StartedApp> {
  const requests: GovernedResponseRequest[] = [];
  let responseNumber = 0;
  const defaultProvider: ResponsesProvider = {
    async countInput() {
      return 100;
    },
    async createResponse(request) {
      requests.push(request);
      responseNumber += 1;
      return {
        id: `resp_${responseNumber}`,
        model: "gpt-5.4-mini",
        serviceTier: "default",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: responseNumber === 1 ? "Working." : "Final answer."
              }
            ]
          }
        ],
        usage: {
          inputTokens: 100,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          totalTokens: 120
        }
      } satisfies TerminalResponse;
    }
  };
  const app = createApp({
    provider:
      provider === undefined
        ? defaultProvider
        : provider,
    jobIdFactory: () => "job_test",
    now: () => new Date("2026-07-18T12:00:00.000Z")
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests
  };
}

async function createJob(
  baseUrl: string,
  body: Record<string, unknown> = { budget_usd: "0.075" }
): Promise<Response> {
  return fetch(`${baseUrl}/v1/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

describe("governed jobs API", () => {
  it("creates, executes, inspects, and explicitly finalizes a job", async () => {
    const { baseUrl, requests } = await startApp();
    const createdResponse = await createJob(baseUrl);
    const created = (await createdResponse.json()) as {
      id: string;
      status: string;
      policy: {
        budget_usd: string;
        final_reserve_usd: string;
      };
      accounting: { settled_usd: string };
    };

    expect(createdResponse.status).toBe(201);
    expect(created).toMatchObject({
      id: "job_test",
      status: "open",
      policy: {
        budget_usd: "0.075000",
        final_reserve_usd: "0.015000"
      },
      accounting: { settled_usd: "0.000000" }
    });

    const workResponse = await fetch(
      `${baseUrl}/v1/jobs/job_test/responses`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "review:work:1",
          phase: "work",
          input: "Review this change.",
          max_output_tokens: 200,
          minimum_output_tokens: 32
        })
      }
    );
    const work = (await workResponse.json()) as {
      execution: {
        status: string;
        reservation: {
          exact_input_tokens: number;
          max_output_tokens: number;
          settled_usd: string;
        };
      };
      job: {
        status: string;
        accounting: {
          settled_usd: string;
          responses_started: number;
        };
      };
    };

    expect(workResponse.status).toBe(200);
    expect(work).toMatchObject({
      execution: {
        status: "settled",
        reservation: {
          exact_input_tokens: 100,
          max_output_tokens: 200,
          settled_usd: "0.000165"
        }
      },
      job: {
        status: "open",
        accounting: {
          settled_usd: "0.000165",
          responses_started: 1
        }
      }
    });
    expect(requests[0]).toMatchObject({
      model: "gpt-5.4-mini",
      input: "Review this change.",
      max_output_tokens: 200,
      parallel_tool_calls: false,
      store: false,
      truncation: "disabled"
    });

    const replayResponse = await fetch(
      `${baseUrl}/v1/jobs/job_test/responses`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "review:work:1",
          phase: "work",
          input: "Review this change.",
          max_output_tokens: 200,
          minimum_output_tokens: 32
        })
      }
    );
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toMatchObject({
      execution: {
        status: "settled",
        response: {
          id: "resp_1",
          output: expect.any(Array)
        }
      },
      job: {
        accounting: { responses_started: 1 }
      }
    });
    expect(requests).toHaveLength(1);

    const retrieveResponse = await fetch(
      `${baseUrl}/v1/jobs/job_test/responses/${encodeURIComponent("review:work:1")}`
    );
    expect(retrieveResponse.status).toBe(200);
    expect(await retrieveResponse.json()).toMatchObject({
      execution: {
        status: "settled",
        response: {
          id: "resp_1",
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: "Working." }
              ]
            }
          ]
        }
      }
    });
    expect(requests).toHaveLength(1);

    const finalResponse = await fetch(
      `${baseUrl}/v1/jobs/job_test/responses`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "review:final",
          phase: "final",
          input: "Return the final review.",
          max_output_tokens: 300,
          minimum_output_tokens: 256
        })
      }
    );
    const final = (await finalResponse.json()) as {
      job: {
        status: string;
        pending_final_validation_request_id: string | null;
      };
    };

    expect(finalResponse.status).toBe(200);
    expect(final.job).toMatchObject({
      status: "validation_required",
      pending_final_validation_request_id: "review:final"
    });

    const finalizeResponse = await fetch(
      `${baseUrl}/v1/jobs/job_test/finalize`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "review:final",
          accepted: true
        })
      }
    );
    const finalized = (await finalizeResponse.json()) as {
      status: string;
      completion_accepted: boolean;
    };

    expect(finalizeResponse.status).toBe(200);
    expect(finalized).toMatchObject({
      status: "completed",
      completion_accepted: true
    });

    const inspectResponse = await fetch(
      `${baseUrl}/v1/jobs/job_test`
    );
    expect(inspectResponse.status).toBe(200);
    expect(await inspectResponse.json()).toMatchObject({
      id: "job_test",
      status: "completed",
      accounting: {
        settled_usd: "0.000330",
        responses_started: 2
      },
      requests: [
        {
          request_id: "review:work:1",
          status: "settled",
          retrieve_path:
            "/v1/jobs/job_test/responses/review%3Awork%3A1"
        },
        {
          request_id: "review:final",
          status: "settled"
        }
      ]
    });
  });

  it("rejects malformed money and budgets that cannot fund the final call", async () => {
    const { baseUrl } = await startApp();

    const numeric = await createJob(baseUrl, { budget_usd: 0.075 });
    expect(numeric.status).toBe(400);
    expect(await numeric.json()).toMatchObject({
      error: { code: "INVALID_JOB_REQUEST" }
    });

    const tooPrecise = await createJob(baseUrl, {
      budget_usd: "0.0000001"
    });
    expect(tooPrecise.status).toBe(400);
    expect(await tooPrecise.json()).toMatchObject({
      error: { code: "INVALID_JOB_REQUEST" }
    });

    const workflowOnlyPolicy = await createJob(baseUrl, {
      budget_usd: "0.075",
      max_equivalent_retries: 1
    });
    expect(workflowOnlyPolicy.status).toBe(400);
    expect(await workflowOnlyPolicy.json()).toMatchObject({
      error: { code: "INVALID_JOB_REQUEST" }
    });

    const tooLow = await createJob(baseUrl, {
      budget_usd: "0.001"
    });
    expect(tooLow.status).toBe(400);
    expect(await tooLow.json()).toMatchObject({
      error: { code: "BUDGET_TOO_LOW" }
    });
  });

  it("does not mutate a job when no live provider is configured", async () => {
    const { baseUrl } = await startApp(null);
    expect((await createJob(baseUrl)).status).toBe(201);

    const response = await fetch(
      `${baseUrl}/v1/jobs/job_test/responses`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "no-provider",
          phase: "work",
          input: "Do work."
        })
      }
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "PROVIDER_NOT_CONFIGURED" }
    });

    const inspected = await fetch(`${baseUrl}/v1/jobs/job_test`);
    expect(await inspected.json()).toMatchObject({
      status: "open",
      accounting: {
        settled_micro_usd: 0,
        reserved_micro_usd: 0,
        responses_started: 0
      }
    });
  });

  it("returns an auditable policy denial without dispatching", async () => {
    let createCalls = 0;
    const provider: ResponsesProvider = {
      async countInput() {
        return 100_000;
      },
      async createResponse() {
        createCalls += 1;
        throw new Error("must not dispatch");
      }
    };
    const { baseUrl } = await startApp(provider);
    expect((await createJob(baseUrl)).status).toBe(201);

    const response = await fetch(
      `${baseUrl}/v1/jobs/job_test/responses`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "too-expensive",
          phase: "work",
          input: "Large context."
        })
      }
    );
    const body = (await response.json()) as {
      error: {
        code: string;
        details: {
          execution: { reason: string };
          job: { status: string };
        };
      };
    };

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      error: {
        code: "GOVERNOR_DENIED",
        details: {
          execution: {
            reason: "INPUT_EXCEEDS_AVAILABLE_BUDGET"
          },
          job: { status: "open" }
        }
      }
    });
    expect(createCalls).toBe(0);
  });

  it("locks an ambiguous provider outcome for reconciliation", async () => {
    const provider: ResponsesProvider = {
      async countInput() {
        return 100;
      },
      async createResponse() {
        throw new Error("connection lost after dispatch");
      }
    };
    const { baseUrl } = await startApp(provider);
    expect((await createJob(baseUrl)).status).toBe(201);

    const response = await fetch(
      `${baseUrl}/v1/jobs/job_test/responses`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "ambiguous",
          phase: "work",
          input: "Do work."
        })
      }
    );
    const body = (await response.json()) as {
      execution: { status: string; reason: string };
      job: {
        status: string;
        accounting: { reserved_micro_usd: number };
      };
    };

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      execution: {
        status: "unresolved",
        reason: "transport_error"
      },
      job: {
        status: "reconciliation_required"
      }
    });
    expect(body.job.accounting.reserved_micro_usd).toBeGreaterThan(0);
  });

  it("aborts provider work when the HTTP client disconnects", async () => {
    let observedSignal:
      | ((signal: AbortSignal | undefined) => void)
      | undefined;
    const signalObserved = new Promise<AbortSignal | undefined>((resolve) => {
      observedSignal = resolve;
    });
    const provider: ResponsesProvider = {
      async countInput(_context, signal) {
        observedSignal?.(signal);
        return await new Promise<number>((resolve, reject) => {
          const timeout = setTimeout(() => resolve(100), 2_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("aborted")
              );
            },
            { once: true }
          );
        });
      },
      async createResponse() {
        throw new Error("must not dispatch");
      }
    };
    const { baseUrl } = await startApp(provider);
    expect((await createJob(baseUrl)).status).toBe(201);

    const controller = new AbortController();
    const response = fetch(`${baseUrl}/v1/jobs/job_test/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: "client-disconnect",
        phase: "work",
        input: "Cancel this request."
      }),
      signal: controller.signal
    });
    const providerSignal = await signalObserved;
    controller.abort();

    await expect(response).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(providerSignal).toBeDefined();
    expect(providerSignal?.aborted).toBe(true);
  });

  it("stores and replays definitive provider rejection receipts", async () => {
    let countCalls = 0;
    let createCalls = 0;
    const provider: ResponsesProvider = {
      async countInput() {
        countCalls += 1;
        return 100;
      },
      async createResponse() {
        createCalls += 1;
        throw new OpenAiApiError("rate limited", {
          status: 429,
          requestId: "req_rate_limited",
          ambiguous: false
        });
      }
    };
    const { baseUrl } = await startApp(provider);
    expect((await createJob(baseUrl)).status).toBe(201);
    const request = {
      request_id: "provider-rejection",
      phase: "work",
      input: "Do governed work."
    };
    const send = () =>
      fetch(`${baseUrl}/v1/jobs/job_test/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });

    const first = await send();
    const firstBody = await first.json();
    expect(first.status).toBe(502);
    expect(firstBody).toMatchObject({
      error: {
        code: "PROVIDER_REJECTED",
        details: {
          execution: {
            status: "provider_rejected",
            provider_error: {
              http_status: 429,
              provider_request_id: "req_rate_limited",
              ambiguous: false
            },
            reservation: {
              status: "released",
              terminal_reason: "provider_rejected",
              provider_rejection: {
                http_status: 429,
                provider_request_id: "req_rate_limited"
              }
            }
          },
          job: {
            status: "open",
            accounting: {
              reserved_micro_usd: 0,
              responses_started: 1
            }
          }
        }
      }
    });

    const replay = await send();
    expect(replay.status).toBe(502);
    expect(await replay.json()).toEqual(firstBody);
    expect(countCalls).toBe(1);
    expect(createCalls).toBe(1);

    const retrieved = await fetch(
      `${baseUrl}/v1/jobs/job_test/responses/provider-rejection`
    );
    expect(retrieved.status).toBe(200);
    expect(await retrieved.json()).toMatchObject({
      execution: {
        status: "provider_rejected",
        provider_error: { http_status: 429 }
      }
    });
  });

  it("coalesces concurrent identical request IDs into one provider dispatch", async () => {
    let releaseResponse: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let countCalls = 0;
    let createCalls = 0;
    const provider: ResponsesProvider = {
      async countInput() {
        countCalls += 1;
        return 100;
      },
      async createResponse() {
        createCalls += 1;
        await gate;
        return {
          id: "resp_race",
          model: "gpt-5.4-mini",
          serviceTier: "default",
          status: "completed",
          output: [],
          usage: {
            inputTokens: 100,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 10,
            reasoningOutputTokens: 0,
            totalTokens: 110
          }
        };
      }
    };
    const { baseUrl } = await startApp(provider);
    expect((await createJob(baseUrl)).status).toBe(201);
    const request = {
      request_id: "same-request",
      phase: "work",
      input: "Same logical operation."
    };
    const send = () =>
      fetch(`${baseUrl}/v1/jobs/job_test/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });

    const first = send();
    const second = send();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(countCalls).toBe(1);
    expect(createCalls).toBe(1);
    releaseResponse?.();

    const [firstResponse, secondResponse] = await Promise.all([
      first,
      second
    ]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    const [firstBody, secondBody] = await Promise.all([
      firstResponse.json(),
      secondResponse.json()
    ]);
    expect(firstBody).toEqual(secondBody);
    expect(countCalls).toBe(1);
    expect(createCalls).toBe(1);
  });

  it("rejects request ID reuse with a different response intent", async () => {
    const { baseUrl, requests } = await startApp();
    expect((await createJob(baseUrl)).status).toBe(201);
    const first = await fetch(
      `${baseUrl}/v1/jobs/job_test/responses`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "stable-id",
          phase: "work",
          input: "Original input."
        })
      }
    );
    expect(first.status).toBe(200);

    const conflict = await fetch(
      `${baseUrl}/v1/jobs/job_test/responses`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "stable-id",
          phase: "work",
          input: "Changed input."
        })
      }
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "REQUEST_ID_CONFLICT" }
    });
    expect(requests).toHaveLength(1);
  });

  it("funds custom final floors above the ordinary default and forbids final tools", async () => {
    const { baseUrl, requests } = await startApp();
    const created = await createJob(baseUrl, {
      budget_usd: "0.100",
      minimum_final_output_tokens: 2_000
    });
    expect(created.status).toBe(201);

    const withTools = await fetch(
      `${baseUrl}/v1/jobs/job_test/responses`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "final-with-tools",
          phase: "final",
          input: "Finish.",
          tools: [
            {
              type: "function",
              name: "not_allowed",
              parameters: { type: "object" }
            }
          ]
        })
      }
    );
    expect(withTools.status).toBe(400);
    expect(await withTools.json()).toMatchObject({
      error: { code: "FINAL_TOOLS_NOT_ALLOWED" }
    });
    expect(requests).toHaveLength(0);

    const final = await fetch(
      `${baseUrl}/v1/jobs/job_test/responses`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "large-final-floor",
          phase: "final",
          input: "Finish."
        })
      }
    );
    expect(final.status).toBe(200);
    expect(requests[0]?.max_output_tokens).toBe(2_000);
  });
});
