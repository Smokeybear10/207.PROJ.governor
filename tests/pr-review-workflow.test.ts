import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../server/artifacts/index.js";
import {
  GPT_5_4_MINI_STANDARD_RATE_CARD,
  ReservationLedger,
  createGovernorPolicy
} from "../server/governor/index.js";
import type {
  GovernedResponseRequest,
  ResponseContext,
  TerminalResponse
} from "../server/openai/index.js";
import {
  runGovernedPrReview,
  type PrReviewSnapshot
} from "../server/review/index.js";
import type { ResponsesProvider } from "../server/runtime/index.js";
import {
  ScriptedResponsesProvider,
  type ScriptedResponse
} from "./helpers/scripted-responses-provider.js";

const rateCard = GPT_5_4_MINI_STANDARD_RATE_CARD;

function createLedger(
  overrides: Partial<Parameters<typeof createGovernorPolicy>[0]> = {}
): ReservationLedger {
  return new ReservationLedger(
    createGovernorPolicy({
      applicationCeilingMicroUsd: 20_000,
      finalAnswerReserveMicroUsd: 10_000,
      finalAnswerInputTokenLimit: 5_000,
      minimumFinalOutputTokens: 500,
      maxResponses: 4,
      maxEquivalentRetries: 1,
      rateCardVersion: rateCard.version,
      ...overrides
    }),
    rateCard
  );
}

function snapshot(): PrReviewSnapshot {
  return {
    diff: [
      "diff --git a/src/retry.ts b/src/retry.ts",
      "--- a/src/retry.ts",
      "+++ b/src/retry.ts",
      "@@ -1,2 +1,3 @@",
      "+export const attempts = 3;"
    ].join("\n"),
    files: {
      "src/retry.ts": [
        "export function retry() {",
        "  return attempts < 3;",
        "}"
      ].join("\n")
    },
    ciLog: [
      "FAIL retry boundary",
      "AssertionError: expected 2 retries, received 3"
    ].join("\n"),
    ciExitCode: 1
  };
}

function reasoning(id: string) {
  return {
    id,
    type: "reasoning",
    status: "completed",
    summary: [],
    encrypted_content: `encrypted-${id}`
  };
}

function toolCall(
  id: string,
  callId: string,
  name: string,
  argumentsValue: Record<string, unknown>
) {
  return {
    id,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name,
    arguments: JSON.stringify(argumentsValue)
  };
}

function message(id: string, text: string) {
  return {
    id,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }]
  };
}

function finding(
  overrides: Partial<{
    category: string;
    severity: "P0" | "P1" | "P2" | "P3";
    path: string;
    start_line: number;
    end_line: number;
    explanation: string;
    suggested_mitigation: string;
  }> = {}
) {
  return {
    category: "correctness",
    severity: "P1" as const,
    path: "src/retry.ts",
    start_line: 2,
    end_line: 2,
    explanation:
      "The retry condition permits a third attempt after the expected boundary.",
    suggested_mitigation:
      "Change the boundary and retain a regression test for two retries.",
    ...overrides
  };
}

function findingsReview(...findings: ReturnType<typeof finding>[]) {
  return JSON.stringify({ status: "findings", findings });
}

function cleanReview() {
  return JSON.stringify({ status: "clean" });
}

function fullWorkflowScripts(): ScriptedResponse[] {
  return [
    {
      inputTokens: 100,
      outputTokens: 20,
      output: [
        reasoning("rs_1"),
        toolCall("fc_1", "call_diff", "read_pr_diff", {})
      ]
    },
    {
      inputTokens: 200,
      outputTokens: 20,
      output: [
        reasoning("rs_2"),
        toolCall("fc_2", "call_file", "read_file", {
          path: "src/retry.ts",
          start_line: 1,
          end_line: 3
        })
      ]
    },
    {
      inputTokens: 300,
      outputTokens: 20,
      output: [
        reasoning("rs_3"),
        toolCall("fc_3", "call_ci", "read_ci_log", {})
      ]
    },
    {
      inputTokens: 400,
      outputTokens: 40,
      output: [
        reasoning("rs_4"),
        message(
          "msg_final",
          findingsReview(finding())
        )
      ]
    }
  ];
}

describe("governed PR review workflow", () => {
  it("runs three fixed tools and one governed final response", async () => {
    const provider = new ScriptedResponsesProvider(fullWorkflowScripts());
    const ledger = createLedger();

    const result = await runGovernedPrReview({
      jobId: "review-1",
      ledger,
      provider,
      snapshot: snapshot(),
      artifactStore: new MemoryArtifactStore(),
      workMaxOutputTokens: 256,
      workMinimumOutputTokens: 16,
      finalMaxOutputTokens: 600
    });

    expect(result).toMatchObject({
      status: "completed",
      toolCalls: 3,
      finalText: findingsReview(finding()),
      finalReview: {
        status: "findings",
        findings: [finding()]
      },
      snapshot: {
        closed: true,
        completionAccepted: true,
        responsesStarted: 4
      }
    });
    provider.assertComplete();
    expect(provider.contexts).toHaveLength(4);
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests[3].tools).toBeUndefined();

    const secondInput = provider.requests[1].input as Array<
      Record<string, unknown>
    >;
    expect(secondInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          encrypted_content: "encrypted-rs_1"
        }),
        expect.objectContaining({
          type: "function_call",
          call_id: "call_diff"
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_diff"
        })
      ])
    );
    for (const request of provider.requests) {
      expect(request).toMatchObject({
        include: ["reasoning.encrypted_content"],
        parallel_tool_calls: false,
        store: false,
        truncation: "disabled",
        service_tier: "default"
      });
    }
  });

  it("never executes a tool or final call after ambiguous work", async () => {
    let createCalls = 0;
    const provider: ResponsesProvider = {
      async countInput() {
        return 100;
      },
      async createResponse() {
        createCalls += 1;
        throw new Error("socket closed after write");
      }
    };

    const result = await runGovernedPrReview({
      jobId: "review-ambiguous",
      ledger: createLedger(),
      provider,
      snapshot: snapshot(),
      workMaxOutputTokens: 256,
      workMinimumOutputTokens: 16,
      finalMaxOutputTokens: 600
    });

    expect(result).toMatchObject({
      status: "stopped",
      reason: "WORK_UNRESOLVED",
      toolCalls: 0,
      snapshot: {
        outstandingReservedMicroUsd: expect.any(Number)
      }
    });
    expect(result.snapshot.outstandingReservedMicroUsd).toBeGreaterThan(0);
    expect(createCalls).toBe(1);
  });

  it("fails closed on an unknown tool without attempting final", async () => {
    const provider = new ScriptedResponsesProvider([
      {
        inputTokens: 100,
        outputTokens: 20,
        output: [
          toolCall("fc_bad", "call_bad", "run_shell", {
            command: "cat .env"
          })
        ]
      }
    ]);

    const result = await runGovernedPrReview({
      jobId: "review-unknown-tool",
      ledger: createLedger(),
      provider,
      snapshot: snapshot(),
      workMaxOutputTokens: 256,
      workMinimumOutputTokens: 16,
      finalMaxOutputTokens: 600
    });

    expect(result).toMatchObject({
      status: "stopped",
      reason: "TOOL_ERROR",
      toolCalls: 0
    });
    provider.assertComplete();
    expect(provider.requests).toHaveLength(1);
  });

  it("uses the last complete transcript after incomplete work", async () => {
    const provider = new ScriptedResponsesProvider([
      {
        inputTokens: 100,
        outputTokens: 5,
        status: "incomplete",
        output: []
      },
      {
        inputTokens: 120,
        outputTokens: 20,
        output: [message("msg_final", cleanReview())]
      }
    ]);

    const result = await runGovernedPrReview({
      jobId: "review-incomplete",
      ledger: createLedger(),
      provider,
      snapshot: snapshot(),
      workMaxOutputTokens: 256,
      workMinimumOutputTokens: 16,
      finalMaxOutputTokens: 600
    });

    expect(result).toMatchObject({
      status: "completed",
      finalText: cleanReview(),
      finalReview: { status: "clean" },
      toolCalls: 0,
      snapshot: { completionAccepted: true }
    });
    provider.assertComplete();
    expect(provider.requests).toHaveLength(2);
  });

  it("rejects malformed nonempty final output", async () => {
    const provider = new ScriptedResponsesProvider([
      {
        inputTokens: 100,
        outputTokens: 10,
        output: [message("msg_work", "Evidence collection complete.")]
      },
      {
        inputTokens: 120,
        outputTokens: 10,
        output: [message("msg_final", "No supported finding.")]
      }
    ]);
    const ledger = createLedger();

    const result = await runGovernedPrReview({
      jobId: "review-invalid-final",
      ledger,
      provider,
      snapshot: snapshot(),
      workMaxOutputTokens: 256,
      workMinimumOutputTokens: 16,
      finalMaxOutputTokens: 600
    });

    expect(result).toMatchObject({
      status: "stopped",
      reason: "FINAL_OUTPUT_INVALID",
      snapshot: {
        closed: true,
        completionAccepted: false,
        pendingFinalValidationRequestId: null
      }
    });
    provider.assertComplete();
  });

  it.each([
    {
      label: "fabricated path",
      evidence: {
        path: "src/fabricated.ts"
      }
    },
    {
      label: "fabricated line range",
      evidence: {
        start_line: 4,
        end_line: 4
      }
    }
  ])("rejects $label evidence", async ({ label, evidence }) => {
    const provider = new ScriptedResponsesProvider([
      {
        inputTokens: 100,
        outputTokens: 10,
        output: [message("msg_work", "Evidence collection complete.")]
      },
      {
        inputTokens: 120,
        outputTokens: 30,
        output: [
          message(
            `msg_final_${label.replaceAll(" ", "_")}`,
            findingsReview(finding(evidence))
          )
        ]
      }
    ]);

    const result = await runGovernedPrReview({
      jobId: `review-${label.replaceAll(" ", "-")}`,
      ledger: createLedger(),
      provider,
      snapshot: snapshot(),
      workMaxOutputTokens: 256,
      workMinimumOutputTokens: 16,
      finalMaxOutputTokens: 600
    });

    expect(result).toMatchObject({
      status: "stopped",
      reason: "FINAL_OUTPUT_INVALID",
      snapshot: {
        closed: true,
        completionAccepted: false
      }
    });
    provider.assertComplete();
  });

  it("accepts the explicit clean result", async () => {
    const provider = new ScriptedResponsesProvider([
      {
        inputTokens: 100,
        outputTokens: 10,
        output: [message("msg_work", "Evidence collection complete.")]
      },
      {
        inputTokens: 120,
        outputTokens: 10,
        output: [message("msg_final", cleanReview())]
      }
    ]);

    const result = await runGovernedPrReview({
      jobId: "review-clean",
      ledger: createLedger(),
      provider,
      snapshot: snapshot(),
      workMaxOutputTokens: 256,
      workMinimumOutputTokens: 16,
      finalMaxOutputTokens: 600
    });

    expect(result).toMatchObject({
      status: "completed",
      finalReview: { status: "clean" },
      snapshot: {
        closed: true,
        completionAccepted: true
      }
    });
    provider.assertComplete();
  });

  it("validates a tool call before retry fingerprinting", async () => {
    const provider = new ScriptedResponsesProvider([
      {
        inputTokens: 100,
        outputTokens: 20,
        output: [
          toolCall("fc_1", "call_diff_1", "read_pr_diff", {})
        ]
      },
      {
        inputTokens: 150,
        outputTokens: 20,
        output: [
          toolCall("fc_2", "call_diff_2", "read_pr_diff", {})
        ]
      },
      {
        inputTokens: 175,
        outputTokens: 20,
        output: [
          toolCall("fc_3", "call_diff_3", "READ_PR_DIFF", {})
        ]
      }
    ]);

    const result = await runGovernedPrReview({
      jobId: "review-tool-validation-order",
      ledger: createLedger({ maxEquivalentRetries: 1 }),
      provider,
      snapshot: snapshot(),
      workMaxOutputTokens: 256,
      workMinimumOutputTokens: 16,
      finalMaxOutputTokens: 600
    });

    expect(result).toMatchObject({
      status: "stopped",
      reason: "TOOL_ERROR",
      toolCalls: 2
    });
    expect(result.trace).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "retry",
          callId: "call_diff_3"
        })
      ])
    );
    provider.assertComplete();
  });

  it("suppresses an equivalent read against the same trusted snapshot", async () => {
    const provider = new ScriptedResponsesProvider([
      {
        inputTokens: 100,
        outputTokens: 20,
        output: [
          toolCall("fc_1", "call_diff_1", "read_pr_diff", {})
        ]
      },
      {
        inputTokens: 150,
        outputTokens: 20,
        output: [
          toolCall("fc_2", "call_diff_2", "read_pr_diff", {})
        ]
      },
      {
        inputTokens: 180,
        outputTokens: 20,
        output: [
          toolCall("fc_3", "call_diff_3", "read_pr_diff", {})
        ]
      },
      {
        inputTokens: 200,
        outputTokens: 20,
        output: [message("msg_final", cleanReview())]
      }
    ]);

    const result = await runGovernedPrReview({
      jobId: "review-equivalent-retry",
      ledger: createLedger({ maxEquivalentRetries: 1 }),
      provider,
      snapshot: snapshot(),
      workMaxOutputTokens: 256,
      workMinimumOutputTokens: 16,
      finalMaxOutputTokens: 600
    });

    expect(result).toMatchObject({
      status: "completed",
      toolCalls: 2,
      snapshot: { completionAccepted: true }
    });
    expect(result.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "retry",
          callId: "call_diff_3",
          state: "LIMIT_REACHED",
          equivalentRetryCount: 2,
          allowed: false
        })
      ])
    );
    provider.assertComplete();
  });

  it("denies an oversized final context before model dispatch", async () => {
    const workResponse: TerminalResponse = {
      id: "resp_work",
      model: rateCard.model,
      serviceTier: "default",
      status: "completed",
      output: [message("msg_work", "Ready for final.")],
      usage: {
        inputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
        reasoningOutputTokens: 0,
        totalTokens: 110
      }
    };
    const contexts: ResponseContext[] = [];
    const requests: GovernedResponseRequest[] = [];
    const provider: ResponsesProvider = {
      async countInput(context) {
        contexts.push(context);
        return contexts.length === 1 ? 100 : 401;
      },
      async createResponse(request) {
        requests.push(request);
        return workResponse;
      }
    };
    const finalBound = 400;
    const minimumFinalOutputTokens = 100;
    const minimumFinalReserve =
      302 + minimumFinalOutputTokens * 5;
    const ledger = createLedger({
      finalAnswerInputTokenLimit: finalBound,
      minimumFinalOutputTokens,
      finalAnswerReserveMicroUsd: minimumFinalReserve
    });

    const result = await runGovernedPrReview({
      jobId: "review-final-bound",
      ledger,
      provider,
      snapshot: snapshot(),
      maxWorkResponses: 1,
      maxToolCalls: 1,
      workMaxOutputTokens: 256,
      workMinimumOutputTokens: 16,
      finalMaxOutputTokens: 200
    });

    expect(result).toMatchObject({
      status: "stopped",
      reason: "FINAL_DENIED"
    });
    expect(contexts).toHaveLength(2);
    expect(requests).toHaveLength(1);
  });
});
