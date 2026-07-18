import { describe, expect, it } from "vitest";
import {
  GPT_5_NANO_STANDARD_RATE_CARD,
  ReservationLedger,
  calculateWorstCaseRequestCost,
  createGovernorPolicy,
  type GovernorPolicy
} from "../server/governor/index.js";
import { createBudgetToolbox } from "../server/repair/budget-tools.js";

const rateCard = GPT_5_NANO_STANDARD_RATE_CARD;

const FINAL_INPUT_LIMIT = 2_000;
const MINIMUM_FINAL_OUTPUT = 500;

// The policy's final reserve must be able to fund the bounded final request
// (see ReservationLedger constructor). Derive the floor from the pure cost
// function so the fixture stays correct if the card changes.
const boundedFinalCost = calculateWorstCaseRequestCost(
  rateCard,
  FINAL_INPUT_LIMIT,
  MINIMUM_FINAL_OUTPUT
).totalMicroUsd;

const basePolicy: GovernorPolicy = createGovernorPolicy({
  applicationCeilingMicroUsd: 1_000_000,
  finalAnswerReserveMicroUsd: 10_000,
  finalAnswerInputTokenLimit: FINAL_INPUT_LIMIT,
  minimumFinalOutputTokens: MINIMUM_FINAL_OUTPUT,
  maxResponses: 6,
  maxEquivalentRetries: 3,
  rateCardVersion: rateCard.version
});

function makeToolbox(
  policy: GovernorPolicy,
  currentInputTokens: () => number
) {
  const ledger = new ReservationLedger(policy, rateCard);
  return createBudgetToolbox(ledger, rateCard, { currentInputTokens });
}

describe("repair budget toolbox", () => {
  it("sanity-checks that the fixture reserve funds the bounded final request", () => {
    expect(basePolicy.finalAnswerReserveMicroUsd).toBeGreaterThanOrEqual(
      boundedFinalCost
    );
  });

  it("exposes the three strict, read-only budget tool definitions", () => {
    const toolbox = makeToolbox(basePolicy, () => 1_000);
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
    const toolbox = makeToolbox(basePolicy, () => 1_000);
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
      basePolicy.applicationCeilingMicroUsd
    );
  });

  it("reports estimate_action_cost as request-capped for a modest intent", async () => {
    const toolbox = makeToolbox(basePolicy, () => 1_000);
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
    const toolbox = makeToolbox(basePolicy, () => 1_000);
    const result = JSON.parse(await toolbox.execute("budget_status", "{}"));

    expect(["SAFE", "WATCH", "AT_RISK"]).toContain(result.riskBand);
    expect(result.riskBand).toBe("SAFE");
    expect(result.responsesRemaining).toBe(basePolicy.maxResponses);
    expect(result.budgetUsedBps).toBeGreaterThanOrEqual(0);
    expect(result.budgetUsedBps).toBeLessThanOrEqual(10_000);
    expect(result.budgetUsedBps).toBe(0);
    expect(result.finalReserveIntact).toBe(true);
  });

  it("flags AT_RISK when only the final response slot remains", async () => {
    const onlyFinalPolicy = createGovernorPolicy({
      ...basePolicy,
      maxResponses: 1
    });
    const toolbox = makeToolbox(onlyFinalPolicy, () => 1_000);
    const result = JSON.parse(await toolbox.execute("budget_status", "{}"));

    expect(result.responsesRemaining).toBe(1);
    expect(result.riskBand).toBe("AT_RISK");
  });

  it("reports a comfortably affordable final answer within the input limit", async () => {
    const toolbox = makeToolbox(basePolicy, () => 1_000);
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
      basePolicy,
      () => basePolicy.finalAnswerInputTokenLimit + 3_000
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
    const toolbox = makeToolbox(basePolicy, () => 1_000);

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
