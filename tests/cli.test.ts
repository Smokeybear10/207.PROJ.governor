import { describe, expect, it, vi } from "vitest";
import { runCli } from "../cli/token-governor.js";

const job = {
  id: "job_test",
  object: "token_governor.job",
  status: "open",
  policy: {
    budget_usd: "0.075000",
    final_reserve_usd: "0.015000",
    final_input_token_limit: 8_192,
    minimum_final_output_tokens: 256,
    max_responses: 4
  },
  accounting: {
    settled_usd: "0.000165",
    reserved_usd: "0.001200",
    committed_usd: "0.001365",
    uncommitted_usd: "0.073635",
    available_for_work_usd: "0.058635",
    responses_started: 1
  },
  pending_final_validation_request_id: null,
  completion_accepted: null
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function createHarness(payload: unknown, status = 200) {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(payload, status)
  );
  const stdout = vi.fn();
  const stderr = vi.fn();

  return {
    fetchMock,
    stdout,
    stderr,
    dependencies: { fetch: fetchMock, stdout, stderr }
  };
}

const responseCreateBaseArgs = [
  "response",
  "create",
  "--job",
  "job_test",
  "--request",
  "review:work:1",
  "--phase",
  "work"
] as const;

const responseCreateArgs = [
  ...responseCreateBaseArgs,
  "--input",
  "Review this change."
] as const;

function responsePayload(output: unknown[]) {
  return {
    object: "token_governor.response",
    execution: {
      status: "settled",
      response: {
        id: "resp_test",
        status: "completed",
        output
      },
      reservation: {
        request_id: "review:work:1",
        status: "settled"
      }
    },
    job
  };
}

describe("Governor CLI", () => {
  it("checks health at the default API URL", async () => {
    const payload = {
      service: "token-governor",
      status: "ready",
      mode: "demo",
      providerConfigured: false
    };
    const harness = createHarness(payload);

    await expect(
      runCli(["health"], harness.dependencies)
    ).resolves.toBe(0);

    expect(harness.fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/health",
      {
        method: "GET",
        headers: { Accept: "application/json" }
      }
    );
    expect(harness.stdout).toHaveBeenCalledWith(
      [
        "Service: token-governor",
        "Status: ready",
        "Mode: demo",
        "Provider configured: false",
        ""
      ].join("\n")
    );
    expect(harness.stderr).not.toHaveBeenCalled();
  });

  it("posts demo inputs and emits only the exact payload in JSON mode", async () => {
    const payload = {
      id: "demo-run:large-failing-log:static:v1",
      status: "COMPLETED",
      events: [{ sequence: 1 }]
    };
    const harness = createHarness(payload, 201);

    const exitCode = await runCli(
      [
        "demo",
        "--scenario",
        "large-failing-log",
        "--controller",
        "static",
        "--json",
        "--api",
        "http://localhost:9000/"
      ],
      harness.dependencies
    );

    expect(exitCode).toBe(0);
    expect(harness.fetchMock).toHaveBeenCalledOnce();
    const [url, init] = harness.fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:9000/api/demo/runs");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      scenarioId: "large-failing-log",
      controller: "static"
    });
    expect(harness.stdout).toHaveBeenCalledWith(
      `${JSON.stringify(payload)}\n`
    );
  });

  it("labels synthetic demo output and renders dollar accounting", async () => {
    const harness = createHarness({
      id: "demo-run:large-failing-log:static:v1",
      truthLabel:
        "DEMO: deterministic synthetic simulation; no external model calls.",
      scenarioId: "large-failing-log",
      controller: "static",
      status: "COMPLETED",
      quality: { gate: "PASSED" },
      taskPolicy: {
        applicationCeilingMicroUsd: 75_000,
        protectedFinalReserveMicroUsd: 15_000
      },
      finalSummary: {
        status: "COMPLETED",
        settledMicroUsd: 31_250,
        unusedMicroUsd: 43_750
      }
    });

    expect(
      await runCli(
        [
          "demo",
          "--scenario",
          "large-failing-log",
          "--controller",
          "static"
        ],
        harness.dependencies
      )
    ).toBe(0);

    const output = String(harness.stdout.mock.calls[0]![0]);
    expect(output).toContain("DEMO: SYNTHETIC DATA\n");
    expect(output).toContain("Run status: COMPLETED\n");
    expect(output).toContain("Quality status: PASSED\n");
    expect(output).toContain("Budget: $0.075000\n");
    expect(output).toContain("Spend: $0.031250\n");
    expect(output).toContain("Reserve: $0.015000\n");
  });

  it("creates jobs with decimal USD strings and numeric policy options", async () => {
    const harness = createHarness(job, 201);

    const exitCode = await runCli(
      [
        "job",
        "create",
        "--budget",
        "0.075",
        "--final-reserve",
        "0.015",
        "--final-input-limit",
        "8192",
        "--min-final-output",
        "256",
        "--max-responses",
        "4"
      ],
      harness.dependencies
    );

    expect(exitCode).toBe(0);
    const [url, init] = harness.fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/jobs");
    expect(JSON.parse(String(init?.body))).toEqual({
      budget_usd: "0.075",
      final_reserve_usd: "0.015",
      final_input_token_limit: 8_192,
      minimum_final_output_tokens: 256,
      max_responses: 4
    });

    const output = String(harness.stdout.mock.calls[0]![0]);
    expect(output).toContain("Status: open\n");
    expect(output).toContain("Budget: $0.075000\n");
    expect(output).toContain("Final reserve: $0.015000\n");
    expect(output).toContain("Spend: $0.000165\n");
    expect(output).toContain("Reserve: $0.001200\n");
  });

  it("shows a job using the selected API URL", async () => {
    const harness = createHarness(job);

    expect(
      await runCli(
        ["--api", "https://governor.example", "job", "show", "job_test"],
        harness.dependencies
      )
    ).toBe(0);

    expect(harness.fetchMock).toHaveBeenCalledWith(
      "https://governor.example/v1/jobs/job_test",
      {
        method: "GET",
        headers: { Accept: "application/json" }
      }
    );
  });

  it("creates responses with snake_case JSON and formats all statuses", async () => {
    const payload = {
      object: "token_governor.response",
      execution: {
        status: "settled",
        response: {
          id: "resp_test",
          status: "completed"
        },
        reservation: {
          request_id: "review:work:1",
          status: "settled"
        }
      },
      job
    };
    const harness = createHarness(payload);

    const exitCode = await runCli(
      [
        "response",
        "create",
        "--job",
        "job_test",
        "--request",
        "review:work:1",
        "--phase",
        "work",
        "--input",
        "Review this change.",
        "--instructions",
        "Be concise.",
        "--max-output",
        "200",
        "--min-output",
        "32"
      ],
      harness.dependencies
    );

    expect(exitCode).toBe(0);
    const [url, init] = harness.fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "http://127.0.0.1:8787/v1/jobs/job_test/responses"
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      request_id: "review:work:1",
      phase: "work",
      input: "Review this change.",
      instructions: "Be concise.",
      max_output_tokens: 200,
      minimum_output_tokens: 32
    });

    const output = String(harness.stdout.mock.calls[0]![0]);
    expect(output).toContain("Execution status: settled\n");
    expect(output).toContain("Provider status: completed\n");
    expect(output).toContain("Reservation status: settled\n");
    expect(output).toContain("Status: open\n");
    expect(output).toContain("Spend: $0.000165\n");
  });

  it("reads response input from an injected file reader", async () => {
    const harness = createHarness(responsePayload([]));
    const readFile = vi.fn(async (_path: string) =>
      Buffer.from("Review the file-backed prompt.", "utf8")
    );
    const readStdin = vi.fn();

    expect(
      await runCli(
        [
          ...responseCreateBaseArgs,
          "--input-file",
          "prompts/review.txt"
        ],
        {
          ...harness.dependencies,
          readFile,
          readStdin
        }
      )
    ).toBe(0);

    expect(readFile).toHaveBeenCalledWith("prompts/review.txt");
    expect(readStdin).not.toHaveBeenCalled();
    const [, init] = harness.fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      input: "Review the file-backed prompt."
    });
  });

  it("reads response input from an injected stdin reader", async () => {
    const harness = createHarness(responsePayload([]));
    const readFile = vi.fn();
    const readStdin = vi.fn(async () => "Review the piped prompt.");

    expect(
      await runCli(
        [...responseCreateBaseArgs, "--stdin"],
        {
          ...harness.dependencies,
          readFile,
          readStdin
        }
      )
    ).toBe(0);

    expect(readStdin).toHaveBeenCalledOnce();
    expect(readFile).not.toHaveBeenCalled();
    const [, init] = harness.fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      input: "Review the piped prompt."
    });
  });

  it("rejects response input larger than 256 KiB before fetching", async () => {
    const harness = createHarness(responsePayload([]));
    const readFile = vi.fn(async () => Buffer.alloc(256 * 1024 + 1));

    expect(
      await runCli(
        [
          ...responseCreateBaseArgs,
          "--input-file",
          "prompts/oversized.txt"
        ],
        {
          ...harness.dependencies,
          readFile
        }
      )
    ).toBe(1);

    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(harness.stderr).toHaveBeenCalledWith(
      "Error: --input-file exceeds the 256 KiB limit\n"
    );
  });

  it("prints ordered assistant output_text parts", async () => {
    const harness = createHarness(
      responsePayload([
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Review ", annotations: [] },
            { type: "output_text", text: "complete.", annotations: [] }
          ]
        }
      ])
    );

    expect(
      await runCli(responseCreateArgs, harness.dependencies)
    ).toBe(0);

    const output = String(harness.stdout.mock.calls[0]![0]);
    expect(output).toContain("Assistant output:\nReview complete.\n");
  });

  it("summarizes provider function calls", async () => {
    const harness = createHarness(
      responsePayload([
        {
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: '{ "path": "src/App.tsx", "line": 12 }'
        }
      ])
    );

    expect(
      await runCli(responseCreateArgs, harness.dependencies)
    ).toBe(0);

    const output = String(harness.stdout.mock.calls[0]![0]);
    expect(output).toContain(
      'Function call: read_file({"path":"src/App.tsx","line":12})\n'
    );
  });

  it("never discloses encrypted reasoning in human output", async () => {
    const harness = createHarness(
      responsePayload([
        {
          type: "reasoning",
          summary: [],
          encrypted_content: "opaque-secret-reasoning"
        },
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Only the usable answer.",
              annotations: []
            }
          ]
        }
      ])
    );

    expect(
      await runCli(responseCreateArgs, harness.dependencies)
    ).toBe(0);

    const output = String(harness.stdout.mock.calls[0]![0]);
    expect(output).toContain("Only the usable answer.");
    expect(output).not.toContain("opaque-secret-reasoning");
    expect(output).not.toContain("encrypted_content");
  });

  it("sanitizes provider and model terminal controls in human output", async () => {
    const payload = responsePayload([
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Visible\u001b[31m answer\u0007",
            annotations: []
          }
        ]
      }
    ]);
    payload.execution.response.id = "resp_\u009b31mtest";
    Object.assign(payload.execution, {
      reason: "provider\u001b]0;title\u0007 note"
    });
    const harness = createHarness(payload);

    expect(
      await runCli(responseCreateArgs, harness.dependencies)
    ).toBe(0);

    const output = String(harness.stdout.mock.calls[0]![0]);
    expect(output).toContain("Visible[31m answer");
    expect(output).not.toMatch(/[\u0007\u001b\u009b]/);
  });

  it.each(["unresolved", "provider_stopped"])(
    "returns exit code 2 for %s while printing the receipt",
    async (status) => {
      const payload = responsePayload([]);
      payload.execution.status = status;
      Object.assign(payload.execution, { reason: "transport_error" });
      const harness = createHarness(payload, status === "unresolved" ? 202 : 200);

      expect(
        await runCli(responseCreateArgs, harness.dependencies)
      ).toBe(2);

      const output = String(harness.stdout.mock.calls[0]![0]);
      expect(output).toContain(`Execution status: ${status}\n`);
      expect(output).toContain("Job\n");
      expect(output).toContain("Budget: $0.075000\n");
      expect(harness.stderr).not.toHaveBeenCalled();
    }
  );

  it("keeps JSON receipts exact when exit code 2 is returned", async () => {
    const payload = responsePayload([
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Raw\u001b[31m payload",
            annotations: []
          }
        ]
      }
    ]);
    payload.execution.status = "unresolved";
    Object.assign(payload.execution, { reason: "transport_error" });
    const harness = createHarness(payload, 202);

    expect(
      await runCli(
        [...responseCreateArgs, "--json"],
        harness.dependencies
      )
    ).toBe(2);

    expect(harness.stdout).toHaveBeenCalledWith(
      `${JSON.stringify(payload)}\n`
    );
  });

  it("finalizes a job with an explicit rejection", async () => {
    const rejectedJob = {
      ...job,
      status: "rejected",
      completion_accepted: false
    };
    const harness = createHarness(rejectedJob);

    expect(
      await runCli(
        [
          "job",
          "finalize",
          "--job",
          "job_test",
          "--request",
          "review:final",
          "--reject",
          "--json"
        ],
        harness.dependencies
      )
    ).toBe(0);

    const [url, init] = harness.fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "http://127.0.0.1:8787/v1/jobs/job_test/finalize"
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      request_id: "review:final",
      accepted: false
    });
    expect(harness.stdout).toHaveBeenCalledWith(
      `${JSON.stringify(rejectedJob)}\n`
    );
  });

  it.each([
    {
      name: "unknown flags",
      args: [
        "demo",
        "--scenario",
        "large-failing-log",
        "--controller",
        "static",
        "--wat"
      ],
      message: "Unknown flag: --wat"
    },
    {
      name: "duplicate flags",
      args: [
        "job",
        "create",
        "--budget",
        "0.1",
        "--budget",
        "0.2"
      ],
      message: "Duplicate flag: --budget"
    },
    {
      name: "missing flag values",
      args: ["job", "create", "--budget"],
      message: "Missing value for --budget"
    },
    {
      name: "USD amounts with seven whole digits",
      args: ["job", "create", "--budget", "1000000"],
      message: "at most 6 whole and 6 fractional digits"
    },
    {
      name: "missing required flags",
      args: ["response", "create", "--job", "job_test"],
      message: "Missing required flag: --request"
    },
    {
      name: "missing response input sources",
      args: [...responseCreateBaseArgs],
      message:
        "requires exactly one of --input, --input-file, or --stdin"
    },
    {
      name: "multiple response input sources",
      args: [
        ...responseCreateBaseArgs,
        "--input",
        "inline",
        "--stdin"
      ],
      message:
        "requires exactly one of --input, --input-file, or --stdin"
    },
    {
      name: "ambiguous finalization",
      args: [
        "job",
        "finalize",
        "--job",
        "job_test",
        "--request",
        "final",
        "--accept",
        "--reject"
      ],
      message: "requires exactly one of --accept or --reject"
    }
  ])("fails on $name before fetching", async ({ args, message }) => {
    const harness = createHarness({});

    expect(await runCli(args, harness.dependencies)).toBe(1);

    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(harness.stdout).not.toHaveBeenCalled();
    expect(harness.stderr).toHaveBeenCalledOnce();
    expect(String(harness.stderr.mock.calls[0]![0])).toContain(message);
  });

  it("fails on non-2xx JSON error envelopes", async () => {
    const harness = createHarness(
      {
        error: {
          code: "GOVERNOR_DENIED",
          message:
            "The request was denied: INPUT_EXCEEDS_AVAILABLE_BUDGET.",
          details: {
            execution: {
              status: "denied",
              reason: "INPUT_EXCEEDS_AVAILABLE_BUDGET"
            }
          }
        }
      },
      409
    );

    const exitCode = await runCli(
      [
        "response",
        "create",
        "--job",
        "job_test",
        "--request",
        "too-expensive",
        "--phase",
        "work",
        "--input",
        "Large context."
      ],
      harness.dependencies
    );

    expect(exitCode).toBe(1);
    expect(harness.stdout).not.toHaveBeenCalled();
    expect(harness.stderr).toHaveBeenCalledWith(
      "Error: HTTP 409 GOVERNOR_DENIED: The request was denied: INPUT_EXCEEDS_AVAILABLE_BUDGET.\n"
    );
  });
});
