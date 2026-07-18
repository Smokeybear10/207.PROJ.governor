import { describe, expect, it } from "vitest";
import { GovernedJobService } from "../server/jobs/index.js";
import {
  ScriptedResponsesProvider,
  type ScriptedResponse
} from "../server/openai/scripted-provider.js";
import { openRepairSession } from "../server/repair/governor-client.js";

function settledWorkScript(): ScriptedResponse[] {
  return [
    {
      inputTokens: 500,
      outputTokens: 20,
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "Investigating the failing build." }
          ]
        }
      ]
    }
  ];
}

describe("repair governor client", () => {
  it("normalizes a settled work turn with output and exact input tokens", async () => {
    const provider = new ScriptedResponsesProvider(settledWorkScript());
    const service = new GovernedJobService({ provider });
    const session = openRepairSession(service, { budget_usd: "1.00" });

    expect(session.jobId.length).toBeGreaterThan(0);

    const before = session.getAccounting();
    expect(before.applicationCeilingMicroUsd).toBe(1_000_000);
    expect(before.responsesStarted).toBe(0);
    expect(before.committedMicroUsd).toBe(0);
    expect(before.availableForWorkMicroUsd).toBeGreaterThan(0);
    expect(before.availableForWorkMicroUsd).toBeLessThan(
      before.applicationCeilingMicroUsd
    );
    expect(before.finalAnswerReserveMicroUsd).toBeGreaterThan(0);

    const result = await session.respond({
      requestId: "session:work:1",
      phase: "work",
      input: "Do the work.",
      instructions: "Investigate the failure.",
      maxOutputTokens: 128,
      minimumOutputTokens: 16
    });

    expect(result.status).toBe("settled");
    if (result.status === "settled") {
      expect(result.exactInputTokens).toBe(500);
      expect(Array.isArray(result.output)).toBe(true);
      expect(result.output.length).toBe(1);
      expect(result.responseId.length).toBeGreaterThan(0);
      expect(result.accounting.responsesStarted).toBe(1);
      expect(result.accounting.committedMicroUsd).toBeGreaterThan(0);
      expect(result.accounting.committedMicroUsd).toBeLessThanOrEqual(
        result.accounting.applicationCeilingMicroUsd
      );
    }

    provider.assertComplete();
  });

  it("normalizes a governor denial into a denied outcome without throwing", async () => {
    const provider = new ScriptedResponsesProvider(settledWorkScript());
    const service = new GovernedJobService({ provider });
    // The final reserve consumes the whole tiny budget, so no work is admissible.
    const session = openRepairSession(service, {
      budget_usd: "0.0001",
      final_input_token_limit: 100,
      minimum_final_output_tokens: 1
    });

    const result = await session.respond({
      requestId: "session:work:1",
      phase: "work",
      input: "Do the work.",
      maxOutputTokens: 128,
      minimumOutputTokens: 16
    });

    expect(result.status).toBe("denied");
    expect(result.accounting.responsesStarted).toBeGreaterThanOrEqual(0);
    expect(result.accounting.committedMicroUsd).toBe(0);
  });
});
