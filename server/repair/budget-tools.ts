import { z } from "zod";
import {
  calculateAdmissibleOutputCap,
  calculateWorstCaseRequestCost,
  ReservationLedger,
  type RateCard
} from "../governor/index.js";
import type { JsonObject } from "../openai/index.js";
import { BUDGET_TOOL_NAMES, type BudgetToolbox } from "./types.js";

/**
 * Budget-aware toolbox for the governed CI-repair agent.
 *
 * These are strictly READ-ONLY shims that expose the governor's cost knowledge
 * to the agent so it can self-optimize spend. They compute exclusively over an
 * immutable `ledger.getSnapshot()` plus the pure cost functions and NEVER
 * mutate the ledger and NEVER call the provider. Every tool returns a compact
 * JSON string that surfaces categorical/band information and derived caps only
 * (never the raw reserve dollars) to keep the signal hard to game.
 */

export const MAX_BUDGET_TOOL_ARGUMENT_BYTES = 8 * 1024;
export const MAX_BUDGET_TOOL_RESULT_BYTES = 16 * 1024;

/**
 * Basis-point denominator. `budgetUsedBps` is reported on a 0-10000 scale so
 * the agent sees fractional-percent resolution without any floating dollars.
 */
const BASIS_POINTS = 10_000;

/** The lowest admissible output cap we still treat as "would be admitted". */
const MINIMUM_ADMISSIBLE_OUTPUT_TOKENS = 1;

export type BudgetToolName = (typeof BUDGET_TOOL_NAMES)[number];

export type BudgetToolErrorCode = "UNKNOWN_TOOL" | "INVALID_ARGUMENTS";

export class BudgetToolError extends Error {
  readonly code: BudgetToolErrorCode;

  constructor(
    code: BudgetToolErrorCode,
    message: string,
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "BudgetToolError";
    this.code = code;
  }
}

const emptyArgumentsSchema = z.object({}).strict();

const estimateActionCostArgumentsSchema = z
  .object({
    intended_output_tokens: z.number().int().safe().positive()
  })
  .strict();

const checkCompletionHeadroomArgumentsSchema = z
  .object({
    desired_final_output_tokens: z.number().int().safe().positive()
  })
  .strict();

export const BUDGET_TOOL_ARGUMENT_SCHEMAS = Object.freeze({
  budget_status: emptyArgumentsSchema,
  estimate_action_cost: estimateActionCostArgumentsSchema,
  check_completion_headroom: checkCompletionHeadroomArgumentsSchema
});

type BudgetStatusArguments = z.infer<typeof emptyArgumentsSchema>;
type EstimateActionCostArguments = z.infer<
  typeof estimateActionCostArgumentsSchema
>;
type CheckCompletionHeadroomArguments = z.infer<
  typeof checkCompletionHeadroomArgumentsSchema
>;

export type ValidatedBudgetToolArguments =
  | BudgetStatusArguments
  | EstimateActionCostArguments
  | CheckCompletionHeadroomArguments;

interface BudgetToolDefinition extends JsonObject {
  readonly type: "function";
  readonly name: BudgetToolName;
  readonly description: string;
  readonly strict: true;
  readonly parameters: Readonly<Record<string, unknown>>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export const BUDGET_TOOL_DEFINITIONS: readonly JsonObject[] = deepFreeze([
  {
    type: "function",
    name: "budget_status",
    description:
      "Report the current governed-spend risk band, remaining response slots, committed-budget usage in basis points, and whether the final-answer reserve is still intact. Returns categorical signal only, never raw dollars.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "estimate_action_cost",
    description:
      "Estimate whether an intended next work request would be admitted under the current budget, returning the budget-admissible output-token cap and the worst-case reservation it would require.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        intended_output_tokens: {
          type: "integer",
          minimum: 1,
          description:
            "The maximum output tokens the agent intends to request for the next work action."
        }
      },
      required: ["intended_output_tokens"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "check_completion_headroom",
    description:
      "Check whether a final answer of the desired output length is affordable within the protected final-answer reserve and input-token bound.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        desired_final_output_tokens: {
          type: "integer",
          minimum: 1,
          description:
            "The output tokens the agent would like to spend on the final answer."
        }
      },
      required: ["desired_final_output_tokens"],
      additionalProperties: false
    }
  }
] satisfies BudgetToolDefinition[]);

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function parseJsonArguments(argumentsValue: unknown): unknown {
  if (typeof argumentsValue !== "string") {
    return argumentsValue;
  }
  if (byteLength(argumentsValue) > MAX_BUDGET_TOOL_ARGUMENT_BYTES) {
    throw new BudgetToolError(
      "INVALID_ARGUMENTS",
      `Tool arguments exceed the ${MAX_BUDGET_TOOL_ARGUMENT_BYTES}-byte limit.`
    );
  }
  try {
    return JSON.parse(argumentsValue) as unknown;
  } catch (error) {
    throw new BudgetToolError(
      "INVALID_ARGUMENTS",
      "Tool arguments must be valid JSON.",
      { cause: error }
    );
  }
}

function parseArguments<T>(schema: z.ZodType<T>, argumentsValue: unknown): T {
  const parsed = schema.safeParse(parseJsonArguments(argumentsValue));
  if (!parsed.success) {
    throw new BudgetToolError(
      "INVALID_ARGUMENTS",
      `Invalid tool arguments: ${z.prettifyError(parsed.error)}`,
      { cause: parsed.error }
    );
  }
  return parsed.data;
}

function validateBudgetToolCall(
  name: string,
  argumentsValue: unknown
): ValidatedBudgetToolArguments {
  switch (name) {
    case "budget_status":
      return parseArguments(
        BUDGET_TOOL_ARGUMENT_SCHEMAS.budget_status,
        argumentsValue
      );
    case "estimate_action_cost":
      return parseArguments(
        BUDGET_TOOL_ARGUMENT_SCHEMAS.estimate_action_cost,
        argumentsValue
      );
    case "check_completion_headroom":
      return parseArguments(
        BUDGET_TOOL_ARGUMENT_SCHEMAS.check_completion_headroom,
        argumentsValue
      );
    default:
      throw new BudgetToolError(
        "UNKNOWN_TOOL",
        `Unknown budget tool "${name}".`
      );
  }
}

function serializeResult(result: Readonly<Record<string, unknown>>): string {
  const serialized = JSON.stringify(result);
  if (byteLength(serialized) > MAX_BUDGET_TOOL_RESULT_BYTES) {
    throw new BudgetToolError(
      "INVALID_ARGUMENTS",
      `Budget tool result exceeds the ${MAX_BUDGET_TOOL_RESULT_BYTES}-byte limit.`
    );
  }
  return serialized;
}

export interface BudgetToolboxOptions {
  /** Exact input-token count of the CURRENT transcript, supplied by the workflow. */
  readonly currentInputTokens: () => number;
}

export function createBudgetToolbox(
  ledger: ReservationLedger,
  rateCard: RateCard,
  options: BudgetToolboxOptions
): BudgetToolbox {
  if (!(ledger instanceof ReservationLedger)) {
    throw new BudgetToolError(
      "INVALID_ARGUMENTS",
      "A ReservationLedger is required."
    );
  }
  if (typeof options?.currentInputTokens !== "function") {
    throw new BudgetToolError(
      "INVALID_ARGUMENTS",
      "options.currentInputTokens must be a function."
    );
  }

  function currentInputTokens(): number {
    const tokens = options.currentInputTokens();
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw new BudgetToolError(
        "INVALID_ARGUMENTS",
        "currentInputTokens() must return a non-negative safe integer."
      );
    }
    return tokens;
  }

  function budgetStatus(): string {
    const snapshot = ledger.getSnapshot();
    const ceiling = snapshot.policy.applicationCeilingMicroUsd;
    const available = snapshot.availableForWorkMicroUsd;
    const responsesRemaining = Math.max(
      0,
      snapshot.policy.maxResponses - snapshot.responsesStarted
    );

    const budgetUsedBps = Math.min(
      BASIS_POINTS,
      Math.max(
        0,
        Math.round((snapshot.committedMicroUsd * BASIS_POINTS) / ceiling)
      )
    );

    // The protected reserve is intact while all committed spend still fits
    // inside the work budget (i.e. nothing has dipped into the reserve yet).
    const finalReserveIntact =
      snapshot.committedMicroUsd <=
      ceiling - snapshot.policy.finalAnswerReserveMicroUsd;

    let riskBand: "SAFE" | "WATCH" | "AT_RISK";
    if (available <= ceiling * 0.1 || responsesRemaining <= 1) {
      riskBand = "AT_RISK";
    } else if (available <= ceiling * 0.35) {
      riskBand = "WATCH";
    } else {
      riskBand = "SAFE";
    }

    return serializeResult({
      tool: "budget_status",
      riskBand,
      responsesRemaining,
      budgetUsedBps,
      finalReserveIntact
    });
  }

  function estimateActionCost(
    arguments_: EstimateActionCostArguments
  ): string {
    const snapshot = ledger.getSnapshot();
    const inputTokens = currentInputTokens();
    const available = snapshot.availableForWorkMicroUsd;

    const admissibleMaxOutputTokens = calculateAdmissibleOutputCap(
      rateCard,
      inputTokens,
      available,
      arguments_.intended_output_tokens
    );
    const worstCase = calculateWorstCaseRequestCost(
      rateCard,
      inputTokens,
      admissibleMaxOutputTokens
    );

    return serializeResult({
      tool: "estimate_action_cost",
      wouldBeAdmitted:
        admissibleMaxOutputTokens >= MINIMUM_ADMISSIBLE_OUTPUT_TOKENS,
      admissibleMaxOutputTokens,
      worstCaseReserveMicroUsd: worstCase.totalMicroUsd,
      outputCappedBy:
        admissibleMaxOutputTokens < arguments_.intended_output_tokens
          ? "budget"
          : "request"
    });
  }

  function checkCompletionHeadroom(
    arguments_: CheckCompletionHeadroomArguments
  ): string {
    const snapshot = ledger.getSnapshot();
    const { policy } = snapshot;
    const inputTokens = currentInputTokens();
    const cappedInputTokens = Math.min(
      inputTokens,
      policy.finalAnswerInputTokenLimit
    );

    const admissibleFinalOutputTokens = calculateAdmissibleOutputCap(
      rateCard,
      cappedInputTokens,
      policy.finalAnswerReserveMicroUsd,
      arguments_.desired_final_output_tokens
    );

    return serializeResult({
      tool: "check_completion_headroom",
      finalAnswerAffordable:
        admissibleFinalOutputTokens >= policy.minimumFinalOutputTokens,
      admissibleFinalOutputTokens,
      withinFinalInputLimit:
        inputTokens <= policy.finalAnswerInputTokenLimit
    });
  }

  async function execute(name: string, args: unknown): Promise<string> {
    const validatedArguments = validateBudgetToolCall(name, args);
    switch (name as BudgetToolName) {
      case "budget_status":
        return budgetStatus();
      case "estimate_action_cost":
        return estimateActionCost(
          validatedArguments as EstimateActionCostArguments
        );
      case "check_completion_headroom":
        return checkCompletionHeadroom(
          validatedArguments as CheckCompletionHeadroomArguments
        );
    }
  }

  return Object.freeze({
    definitions: BUDGET_TOOL_DEFINITIONS,
    execute
  });
}
