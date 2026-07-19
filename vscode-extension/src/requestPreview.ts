import { GovernorApiError } from "./apiClient";

export type RequestQuote = {
  object: "token_governor.quote";
  job_id: string;
  quoted_at: string;
  phase: "work" | "final";
  model: string;
  rate_card_version: string;
  context_sha256: string;
  admitted: boolean;
  reason: string | null;
  exact_input_tokens: number;
  requested_max_output_tokens: number;
  max_output_tokens: number;
  minimum_output_tokens: number;
  max_cost_micro_usd: number | null;
  max_cost_usd: string | null;
  input_cost_usd: string;
  output_cost_usd: string | null;
  protected_final_reserve_usd: string;
  available_after_usd: string | null;
};

function invalid(field: string): never {
  throw new GovernorApiError(`Governor returned an invalid cost preview (${field}).`, 200, "INVALID_RESPONSE");
}

export function parseRequestQuote(value: unknown): RequestQuote {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("quote");
  const raw = value as Record<string, unknown>;
  const text = (field: string): string => typeof raw[field] === "string" && raw[field] !== "" ? raw[field] as string : invalid(field);
  const integer = (field: string): number => Number.isSafeInteger(raw[field]) && (raw[field] as number) >= 0 ? raw[field] as number : invalid(field);
  const money = (field: string): string => {
    const amount = text(field);
    return /^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(amount) ? amount : invalid(field);
  };
  const nullableMoney = (field: string): string | null => raw[field] === null ? null : money(field);
  if (raw.object !== "token_governor.quote") invalid("object");
  if (raw.phase !== "work" && raw.phase !== "final") invalid("phase");
  if (typeof raw.admitted !== "boolean") invalid("admitted");
  const quote: RequestQuote = {
    object: "token_governor.quote",
    job_id: text("job_id"), quoted_at: text("quoted_at"), phase: raw.phase,
    model: text("model"), rate_card_version: text("rate_card_version"), context_sha256: text("context_sha256"),
    admitted: raw.admitted, reason: raw.reason === null ? null : text("reason"),
    exact_input_tokens: integer("exact_input_tokens"),
    requested_max_output_tokens: integer("requested_max_output_tokens"),
    max_output_tokens: integer("max_output_tokens"), minimum_output_tokens: integer("minimum_output_tokens"),
    max_cost_micro_usd: raw.max_cost_micro_usd === null ? null : integer("max_cost_micro_usd"),
    max_cost_usd: nullableMoney("max_cost_usd"), input_cost_usd: money("input_cost_usd"),
    output_cost_usd: nullableMoney("output_cost_usd"),
    protected_final_reserve_usd: money("protected_final_reserve_usd"),
    available_after_usd: nullableMoney("available_after_usd")
  };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(quote.job_id)) invalid("job_id");
  if (!Number.isFinite(Date.parse(quote.quoted_at))) invalid("quoted_at");
  if (!/^[a-f0-9]{64}$/.test(quote.context_sha256)) invalid("context_sha256");
  if (quote.minimum_output_tokens < 1 || quote.requested_max_output_tokens < 1) invalid("output limits");
  if (quote.admitted && (quote.reason !== null || quote.max_cost_usd === null || quote.max_cost_micro_usd === null ||
    quote.max_cost_micro_usd < 1 || quote.output_cost_usd === null || quote.available_after_usd === null ||
    quote.max_output_tokens < quote.minimum_output_tokens || quote.max_output_tokens > quote.requested_max_output_tokens)) invalid("admission");
  if (!quote.admitted && quote.reason === null) invalid("denial reason");
  if (quote.max_cost_usd !== null && Math.round(Number(quote.max_cost_usd) * 1_000_000) !== quote.max_cost_micro_usd) invalid("cost agreement");
  if (quote.admitted && Math.round(Number(quote.input_cost_usd) * 1_000_000) +
    Math.round(Number(quote.output_cost_usd) * 1_000_000) !== quote.max_cost_micro_usd) invalid("cost components");
  return quote;
}

export function quoteDetail(quote: RequestQuote): string {
  const output = quote.max_output_tokens < quote.requested_max_output_tokens
    ? `${quote.max_output_tokens} tokens (reduced from ${quote.requested_max_output_tokens} to fit)`
    : `${quote.max_output_tokens} tokens`;
  return [
    `Job: ${quote.job_id}`,
    `Model: ${quote.model} · ${quote.phase}`,
    `Exact input: ${quote.exact_input_tokens} tokens`,
    `Maximum output: ${output}`,
    `Maximum reservation at pinned rates: ${quote.max_cost_usd === null ? "unavailable" : `$${quote.max_cost_usd}`}`,
    `Protected final reserve: $${quote.protected_final_reserve_usd}`,
    `Available after this request: ${quote.available_after_usd === null ? "unavailable" : `$${quote.available_after_usd}`}`,
    "",
    "Only input tokens have been counted; no response has been generated or budget reserved.",
    quote.admitted
      ? "Sending checks the budget again and enforces this reservation cap at the pinned rates. This is not a provider invoice."
      : "This request cannot be sent under the current job limits."
  ].join("\n");
}

export function confirmedRequestBody(quote: RequestQuote, requestId: string, input: string) {
  if (!quote.admitted || quote.max_cost_usd === null) {
    throw new GovernorApiError("This preview does not authorize a response.", 409, "QUOTE_DENIED");
  }
  return {
    request_id: requestId, phase: quote.phase, input, model: quote.model,
    max_output_tokens: quote.max_output_tokens,
    minimum_output_tokens: quote.minimum_output_tokens,
    max_cost_usd: quote.max_cost_usd
  };
}
