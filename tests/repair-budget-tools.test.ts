import { describe, expect, it } from "vitest";
import {
  GPT_5_4_MINI_STANDARD_RATE_CARD,
  calculateWorstCaseRequestCost
} from "../server/governor/index.js";
import { createBudgetToolbox } from "../server/repair/budget-tools.js";
import type { BudgetAccounting } from "../server/repair/governor-client.js";

const rateCard = GPT_5_4_MINI_STANDARD_RATE_CARD;

const FINAL_INPUT_LIMIT = 2_000;
const MINIMUM_FINAL_OUTPUT = 500;
const APPLICATION_CEILING_MICRO_USD = 1_000_000;
const FINAL_RESERVE_MICRO_USD = 100_000;

// The reserve must be able to fund the bounded final request. Derive the floor
// from the pure cost function so the fixture stays correct if the card changes.
const boundedFinalCost = calculateWorstCaseRequestCost(
  rateCard,
  FINAL_INPUT_LIMIT,
  MINIMUM_FINAL_OUTPUT
).totalMicroUsd;

/** A fresh-job accounting snapshot; overrides model post-spend or policy tweaks. */
function makeAccounting(
  overrides: Partial<BudgetAccounting> = {}
): BudgetAccounting {
  return {
    applicationCeilingMicroUsd: APPLICATION_CEILING_MICRO_USD,
    committedMicroUsd: 0,
    availableForWorkMicroUsd:
      APPLICATION_CEILING_MICRO_USD - FINAL_RESERVE_MICRO_USD,
    finalAnswerReserveMicroUsd: FINAL_RESERVE_MICRO_USD,
    finalAnswerInputTokenLimit: FINAL_INPUT_LIMIT,
    minimumFinalOutputTokens: MINIMUM_FINAL_OUTPUT,
    maxResponses: 6,
    responsesStarted: 0,
    ...overrides
  };
}

function makeToolbox(
  accounting: BudgetAccounting,
  currentInputTokens: () => number
) {
  return createBudgetToolbox({
    getAccounting: () => accounting,
    rateCard,
    currentInputTokens
  });
}

describe("repair budget toolbox", () => {
  it("sanity-checks that the fixture reserve funds the bounded final request", () => {
    expect(FINAL_RESERVE_MICRO_USD).toBeGreaterThanOrEqual(boundedFinalCost);
  });

  it("exposes the three strict, read-only budget tool definitions", () => {
    const toolbox = makeToolbox(makeAccounting(), () => 1_000);
    expect(toolbox.definitions.map((definition) => definition.name)).toEqual([
      "budget_status",
      "estimate_action_cost",
      "check_completion_headroom"
    ]);
    for (const definition of toolbox.definitions) {
      expect(definition).toMatchObject({ type: "function", strict: true });
      expect(definition.parameters).toMatchObject({
        additionalProperties: false
      });
    }
  });

  it("caps estimate_action_cost output by budget when intended is huge", async () => {
    const toolbox = makeToolbox(makeAccounting(), () => 1_000);
    const intended = 10_000_000;
    const result = JSON.parse(
      await toolbox.execute(
        "estimate_action_cost",
        JSON.stringify({ intended_output_tokens: intended })
      )
    );

    expect(result.wouldBeAdmitted).toBe(true);
    expect(result.admissibleMaxOutputTokens).toBeGreaterThanOrEqual(1);
    expect(result.admissibleMaxOutputTokens).toBeLessThan(intended);
    expect(result.outputCappedBy).toBe("budget");
    expect(result.worstCaseReserveMicroUsd).toBeGreaterThan(0);
    expect(result.worstCaseReserveMicroUsd).toBeLessThanOrEqual(
      APPLICATION_CEILING_MICRO_USD
    );
  });

  it("reports estimate_action_cost as request-capped for a modest intent", async () => {
    const toolbox = makeToolbox(makeAccounting(), () => 1_000);
    const result = JSON.parse(
      await toolbox.execute(
        "estimate_action_cost",
        JSON.stringify({ intended_output_tokens: 10 })
      )
    );

    expect(result.admissibleMaxOutputTokens).toBe(10);
    expect(result.outputCappedBy).toBe("request");
    expect(result.wouldBeAdmitted).toBe(true);
  });

  it("returns a valid band, response slots, and intact reserve for a fresh ledger", async () => {
    const toolbox = makeToolbox(makeAccounting(), () => 1_000);
    const result = JSON.parse(await toolbox.execute("budget_status", "{}"));

    expect(["SAFE", "WATCH", "AT_RISK"]).toContain(result.riskBand);
    expect(result.riskBand).toBe("SAFE");
    expect(result.responsesRemaining).toBe(6);
    expect(result.budgetUsedBps).toBeGreaterThanOrEqual(0);
    expect(result.budgetUsedBps).toBeLessThanOrEqual(10_000);
    expect(result.budgetUsedBps).toBe(0);
    expect(result.finalReserveIntact).toBe(true);
  });

  it("flags AT_RISK when only the final response slot remains", async () => {
    const toolbox = makeToolbox(
      makeAccounting({ maxResponses: 1 }),
      () => 1_000
    );
    const result = JSON.parse(await toolbox.execute("budget_status", "{}"));

    expect(result.responsesRemaining).toBe(1);
    expect(result.riskBand).toBe("AT_RISK");
  });

  it("reports a comfortably affordable final answer within the input limit", async () => {
    const toolbox = makeToolbox(makeAccounting(), () => 1_000);
    const result = JSON.parse(
      await toolbox.execute(
        "check_completion_headroom",
        JSON.stringify({ desired_final_output_tokens: MINIMUM_FINAL_OUTPUT })
      )
    );

    expect(result.finalAnswerAffordable).toBe(true);
    expect(result.admissibleFinalOutputTokens).toBeGreaterThanOrEqual(
      MINIMUM_FINAL_OUTPUT
    );
    expect(result.withinFinalInputLimit).toBe(true);
  });

  it("caps the final answer at the input limit and flags an over-limit transcript", async () => {
    const toolbox = makeToolbox(
      makeAccounting(),
      () => FINAL_INPUT_LIMIT + 3_000
    );
    const result = JSON.parse(
      await toolbox.execute(
        "check_completion_headroom",
        JSON.stringify({ desired_final_output_tokens: MINIMUM_FINAL_OUTPUT })
      )
    );

    expect(result.withinFinalInputLimit).toBe(false);
    // The input is capped to the funded bound, so the reserve still affords the
    // minimum final output.
    expect(result.finalAnswerAffordable).toBe(true);
  });

  it("rejects unknown tools and invalid arguments", async () => {
    const toolbox = makeToolbox(makeAccounting(), () => 1_000);

    await expect(toolbox.execute("nope", "{}")).rejects.toMatchObject({
      code: "UNKNOWN_TOOL"
    });
    await expect(
      toolbox.execute("estimate_action_cost", JSON.stringify({}))
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    await expect(
      toolbox.execute(
        "estimate_action_cost",
        JSON.stringify({ intended_output_tokens: 0 })
      )
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
  });
});
