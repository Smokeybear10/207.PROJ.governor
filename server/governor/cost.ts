import {
  assertGovernor,
  requireNonEmptyString,
  requireNonNegativeSafeInteger,
  requirePositiveSafeInteger,
  safeIntegerFromBigInt
} from "./errors.js";

const TOKENS_PER_RATE_UNIT = 1_000_000n;

export const COST_ROUNDING = "CEIL_EACH_AGGREGATE_CHARGE" as const;

export interface TokenRates {
  readonly uncachedInputMicroUsdPerMillionTokens: number;
  readonly cachedInputMicroUsdPerMillionTokens: number;
  readonly cacheWriteInputMicroUsdPerMillionTokens: number;
  readonly outputMicroUsdPerMillionTokens: number;
}

export interface RateCardDefinition {
  readonly provider: string;
  readonly model: string;
  readonly serviceTier: string;
  readonly processingRegion: string;
  readonly version: string;
  readonly currency: "USD";
  readonly effectiveAt: string;
  readonly source: string;
  readonly rates: TokenRates;
}

export type RateCard = Readonly<RateCardDefinition>;

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens?: number;
  readonly totalTokens?: number;
  readonly usageSource: "provider";
}

export interface NormalizedProviderUsage {
  readonly inputTokens: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens?: number;
  readonly usageSource: "provider";
}

export type CostChargeKind =
  | "uncached_input"
  | "cached_input"
  | "cache_write_input"
  | "output";

export interface CostCharge {
  readonly kind: CostChargeKind;
  readonly tokens: number;
  readonly microUsdPerMillionTokens: number;
  readonly microUsd: number;
}

export interface UsageCost {
  readonly rateCardVersion: string;
  readonly currency: "USD";
  readonly rounding: typeof COST_ROUNDING;
  readonly usage: NormalizedProviderUsage;
  readonly charges: readonly CostCharge[];
  readonly totalMicroUsd: number;
}

export interface WorstCaseRequestCost {
  readonly rateCardVersion: string;
  readonly exactInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maximumInputRateMicroUsdPerMillionTokens: number;
  readonly inputPartitionRoundingBufferMicroUsd: number;
  readonly inputMicroUsd: number;
  readonly outputMicroUsd: number;
  readonly totalMicroUsd: number;
  readonly rounding: typeof COST_ROUNDING;
}

function ceilDivide(dividend: bigint, divisor: bigint): bigint {
  return dividend === 0n ? 0n : (dividend + divisor - 1n) / divisor;
}

function priceCharge(
  kind: CostChargeKind,
  tokens: number,
  rate: number
): CostCharge {
  const microUsd = safeIntegerFromBigInt(
    ceilDivide(BigInt(tokens) * BigInt(rate), TOKENS_PER_RATE_UNIT),
    `${kind} charge`
  );
  return Object.freeze({
    kind,
    tokens,
    microUsdPerMillionTokens: rate,
    microUsd
  });
}

function addCharges(charges: readonly CostCharge[]): number {
  return safeIntegerFromBigInt(
    charges.reduce((total, charge) => total + BigInt(charge.microUsd), 0n),
    "Total usage cost"
  );
}

export function createRateCard(definition: RateCardDefinition): RateCard {
  requireNonEmptyString(definition.provider, "provider", "INVALID_RATE_CARD");
  requireNonEmptyString(definition.model, "model", "INVALID_RATE_CARD");
  requireNonEmptyString(
    definition.serviceTier,
    "serviceTier",
    "INVALID_RATE_CARD"
  );
  requireNonEmptyString(
    definition.processingRegion,
    "processingRegion",
    "INVALID_RATE_CARD"
  );
  requireNonEmptyString(definition.version, "version", "INVALID_RATE_CARD");
  requireNonEmptyString(definition.source, "source", "INVALID_RATE_CARD");
  assertGovernor(
    definition.currency === "USD",
    "INVALID_RATE_CARD",
    "Only USD rate cards are supported."
  );
  assertGovernor(
    !Number.isNaN(Date.parse(definition.effectiveAt)),
    "INVALID_RATE_CARD",
    "effectiveAt must be a valid timestamp."
  );

  const rates = definition.rates;
  requirePositiveSafeInteger(
    rates.uncachedInputMicroUsdPerMillionTokens,
    "uncached input rate",
    "INVALID_RATE_CARD"
  );
  requireNonNegativeSafeInteger(
    rates.cachedInputMicroUsdPerMillionTokens,
    "cached input rate",
    "INVALID_RATE_CARD"
  );
  requireNonNegativeSafeInteger(
    rates.cacheWriteInputMicroUsdPerMillionTokens,
    "cache-write input rate",
    "INVALID_RATE_CARD"
  );
  requirePositiveSafeInteger(
    rates.outputMicroUsdPerMillionTokens,
    "output rate",
    "INVALID_RATE_CARD"
  );

  return Object.freeze({
    ...definition,
    rates: Object.freeze({ ...rates })
  });
}

export const GPT_5_4_MINI_STANDARD_RATE_CARD = createRateCard({
  provider: "openai",
  model: "gpt-5.4-mini",
  serviceTier: "standard",
  processingRegion: "global",
  version: "openai-gpt-5.4-mini-standard-2026-07-18",
  currency: "USD",
  effectiveAt: "2026-07-18T00:00:00.000Z",
  source: "https://platform.openai.com/docs/pricing",
  rates: {
    uncachedInputMicroUsdPerMillionTokens: 750_000,
    cachedInputMicroUsdPerMillionTokens: 75_000,
    cacheWriteInputMicroUsdPerMillionTokens: 750_000,
    outputMicroUsdPerMillionTokens: 4_500_000
  }
});

export const GPT_5_NANO_STANDARD_RATE_CARD = createRateCard({
  provider: "openai",
  model: "gpt-5-nano",
  serviceTier: "standard",
  processingRegion: "global",
  version: "openai-gpt-5-nano-standard-2026-07-18",
  currency: "USD",
  effectiveAt: "2026-07-18T00:00:00.000Z",
  source: "https://platform.openai.com/docs/pricing",
  rates: {
    uncachedInputMicroUsdPerMillionTokens: 50_000,
    cachedInputMicroUsdPerMillionTokens: 5_000,
    cacheWriteInputMicroUsdPerMillionTokens: 50_000,
    outputMicroUsdPerMillionTokens: 400_000
  }
});

export function normalizeProviderUsage(
  usage: ProviderUsage
): NormalizedProviderUsage {
  assertGovernor(
    usage.usageSource === "provider",
    "INVALID_USAGE",
    "Usage must come from the provider."
  );
  const inputTokens = requireNonNegativeSafeInteger(
    usage.inputTokens,
    "inputTokens",
    "INVALID_USAGE"
  );
  const cachedInputTokens = requireNonNegativeSafeInteger(
    usage.cachedInputTokens,
    "cachedInputTokens",
    "INVALID_USAGE"
  );
  const cacheWriteTokens = requireNonNegativeSafeInteger(
    usage.cacheWriteTokens ?? 0,
    "cacheWriteTokens",
    "INVALID_USAGE"
  );
  const outputTokens = requireNonNegativeSafeInteger(
    usage.outputTokens,
    "outputTokens",
    "INVALID_USAGE"
  );
  const reasoningOutputTokens = requireNonNegativeSafeInteger(
    usage.reasoningOutputTokens ?? 0,
    "reasoningOutputTokens",
    "INVALID_USAGE"
  );

  assertGovernor(
    BigInt(cachedInputTokens) + BigInt(cacheWriteTokens) <=
      BigInt(inputTokens),
    "INVALID_USAGE",
    "cachedInputTokens plus cacheWriteTokens cannot exceed inputTokens."
  );
  assertGovernor(
    reasoningOutputTokens <= outputTokens,
    "INVALID_USAGE",
    "reasoningOutputTokens cannot exceed outputTokens."
  );

  if (usage.totalTokens !== undefined) {
    requireNonNegativeSafeInteger(
      usage.totalTokens,
      "totalTokens",
      "INVALID_USAGE"
    );
    assertGovernor(
      BigInt(usage.totalTokens) === BigInt(inputTokens) + BigInt(outputTokens),
      "INVALID_USAGE",
      "totalTokens must equal inputTokens plus outputTokens."
    );
  }

  return Object.freeze({
    inputTokens,
    uncachedInputTokens:
      inputTokens - cachedInputTokens - cacheWriteTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningOutputTokens,
    ...(usage.totalTokens === undefined
      ? {}
      : { totalTokens: usage.totalTokens }),
    usageSource: "provider" as const
  });
}

export function calculateUsageCost(
  rateCard: RateCard,
  usage: ProviderUsage
): UsageCost {
  const normalized = normalizeProviderUsage(usage);
  const charges = Object.freeze([
    priceCharge(
      "uncached_input",
      normalized.uncachedInputTokens,
      rateCard.rates.uncachedInputMicroUsdPerMillionTokens
    ),
    priceCharge(
      "cached_input",
      normalized.cachedInputTokens,
      rateCard.rates.cachedInputMicroUsdPerMillionTokens
    ),
    priceCharge(
      "cache_write_input",
      normalized.cacheWriteTokens,
      rateCard.rates.cacheWriteInputMicroUsdPerMillionTokens
    ),
    priceCharge(
      "output",
      normalized.outputTokens,
      rateCard.rates.outputMicroUsdPerMillionTokens
    )
  ]);

  return Object.freeze({
    rateCardVersion: rateCard.version,
    currency: "USD" as const,
    rounding: COST_ROUNDING,
    usage: normalized,
    charges,
    totalMicroUsd: addCharges(charges)
  });
}

function maximumInputRate(rateCard: RateCard): number {
  return Math.max(
    rateCard.rates.uncachedInputMicroUsdPerMillionTokens,
    rateCard.rates.cachedInputMicroUsdPerMillionTokens,
    rateCard.rates.cacheWriteInputMicroUsdPerMillionTokens
  );
}

function inputPartitionRoundingBuffer(
  rateCard: RateCard,
  exactInputTokens: number
): number {
  const positivePartitionRates = [
    rateCard.rates.uncachedInputMicroUsdPerMillionTokens,
    rateCard.rates.cachedInputMicroUsdPerMillionTokens,
    rateCard.rates.cacheWriteInputMicroUsdPerMillionTokens
  ].filter((rate) => rate > 0).length;
  const possibleNonEmptyPartitions = Math.min(
    exactInputTokens,
    positivePartitionRates
  );
  return Math.max(0, possibleNonEmptyPartitions - 1);
}

export function calculateWorstCaseRequestCost(
  rateCard: RateCard,
  exactInputTokens: number,
  maxOutputTokens: number
): WorstCaseRequestCost {
  requireNonNegativeSafeInteger(exactInputTokens, "exactInputTokens");
  requireNonNegativeSafeInteger(maxOutputTokens, "maxOutputTokens");

  const inputRate = maximumInputRate(rateCard);
  const baseInputMicroUsd = priceCharge(
    "uncached_input",
    exactInputTokens,
    inputRate
  ).microUsd;
  const roundingBuffer = inputPartitionRoundingBuffer(
    rateCard,
    exactInputTokens
  );
  const inputMicroUsd = safeIntegerFromBigInt(
    BigInt(baseInputMicroUsd) + BigInt(roundingBuffer),
    "Worst-case input cost"
  );
  const outputMicroUsd = priceCharge(
    "output",
    maxOutputTokens,
    rateCard.rates.outputMicroUsdPerMillionTokens
  ).microUsd;
  const totalMicroUsd = safeIntegerFromBigInt(
    BigInt(inputMicroUsd) + BigInt(outputMicroUsd),
    "Worst-case request cost"
  );

  return Object.freeze({
    rateCardVersion: rateCard.version,
    exactInputTokens,
    maxOutputTokens,
    maximumInputRateMicroUsdPerMillionTokens: inputRate,
    inputPartitionRoundingBufferMicroUsd: roundingBuffer,
    inputMicroUsd,
    outputMicroUsd,
    totalMicroUsd,
    rounding: COST_ROUNDING
  });
}

export function calculateAdmissibleOutputCap(
  rateCard: RateCard,
  exactInputTokens: number,
  availableMicroUsd: number,
  requestedMaxOutputTokens: number
): number {
  requireNonNegativeSafeInteger(exactInputTokens, "exactInputTokens");
  requireNonNegativeSafeInteger(availableMicroUsd, "availableMicroUsd");
  requirePositiveSafeInteger(
    requestedMaxOutputTokens,
    "requestedMaxOutputTokens"
  );

  const inputMicroUsd = calculateWorstCaseRequestCost(
    rateCard,
    exactInputTokens,
    0
  ).inputMicroUsd;
  if (inputMicroUsd > availableMicroUsd) {
    return 0;
  }

  const outputBudgetMicroUsd = availableMicroUsd - inputMicroUsd;
  const affordableOutputTokens =
    (BigInt(outputBudgetMicroUsd) * TOKENS_PER_RATE_UNIT) /
    BigInt(rateCard.rates.outputMicroUsdPerMillionTokens);

  return Number(
    affordableOutputTokens < BigInt(requestedMaxOutputTokens)
      ? affordableOutputTokens
      : BigInt(requestedMaxOutputTokens)
  );
}
