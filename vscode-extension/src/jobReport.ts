import { GovernorApiError } from "./apiClient";
import { parseJobView, type JobView } from "./jobModel";

type ReportReservation = {
  request_id: string;
  phase: "work" | "final";
  status: string;
  exact_input_tokens: number;
  max_output_tokens: number;
  reserved_micro_usd: number;
  reserved_usd: string;
  settled_micro_usd: number | null;
  settled_usd: string | null;
  protected_final_reserve_usd: string;
  context_sha256: string;
  request_sha256: string | null;
  terminal_reason: string | null;
};

export type ReportRequest = {
  sequence: number;
  request_id: string;
  phase: "work" | "final";
  status: string;
  started_at: string;
  request_fingerprint: string;
  outcome_code: string | null;
  reason: string | null;
  reservation: ReportReservation | null;
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    cache_write_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
    total_tokens: number | null;
  } | null;
  provider_response_id: string | null;
};

export type JobReport = {
  object: "token_governor.report";
  schema_version: 1;
  generated_at: string;
  content_included: false;
  job: JobView & {
    created_at: string;
    policy: JobView["policy"] & {
      final_input_token_limit: number;
      minimum_final_output_tokens: number;
    };
    pricing: {
      provider: string;
      model: string;
      service_tier: string;
      request_service_tier: string;
      processing_region: string;
      rate_card_version: string;
      rate_card_source: string;
      rate_card_effective_at: string;
      rates_micro_usd_per_million_tokens: {
        uncachedInputMicroUsdPerMillionTokens: number;
        cachedInputMicroUsdPerMillionTokens: number;
        cacheWriteInputMicroUsdPerMillionTokens: number;
        outputMicroUsdPerMillionTokens: number;
      };
    };
  };
  requests: ReportRequest[];
};

function invalid(field: string): never {
  throw new GovernorApiError(`Governor returned an invalid job report (${field}).`, 200, "INVALID_RESPONSE");
}

function record(value: unknown, field: string): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : invalid(field);
}

function text(value: unknown, field: string): string {
  return typeof value === "string" && value !== "" ? value : invalid(field);
}

function integer(value: unknown, field: string): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : invalid(field);
}

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field);
}

function money(value: unknown, field: string): string {
  const parsed = text(value, field);
  return /^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(parsed) ? parsed : invalid(field);
}

function timestamp(value: unknown, field: string): string {
  const parsed = text(value, field);
  return Number.isFinite(Date.parse(parsed)) ? parsed : invalid(field);
}

function hash(value: unknown, field: string): string {
  const parsed = text(value, field);
  return /^[a-f0-9]{64}$/.test(parsed) ? parsed : invalid(field);
}

function phase(value: unknown): "work" | "final" {
  return value === "work" || value === "final" ? value : invalid("phase");
}

function parseReservation(value: unknown): ReportReservation | null {
  if (value === null) return null;
  const item = record(value, "reservation");
  return {
    request_id: text(item.request_id, "reservation.request_id"),
    phase: phase(item.phase), status: text(item.status, "reservation.status"),
    exact_input_tokens: integer(item.exact_input_tokens, "reservation.exact_input_tokens"),
    max_output_tokens: integer(item.max_output_tokens, "reservation.max_output_tokens"),
    reserved_micro_usd: integer(item.reserved_micro_usd, "reservation.reserved_micro_usd"),
    reserved_usd: money(item.reserved_usd, "reservation.reserved_usd"),
    settled_micro_usd: item.settled_micro_usd === null ? null : integer(item.settled_micro_usd, "reservation.settled_micro_usd"),
    settled_usd: item.settled_usd === null ? null : money(item.settled_usd, "reservation.settled_usd"),
    protected_final_reserve_usd: money(item.protected_final_reserve_usd, "reservation.protected_final_reserve_usd"),
    context_sha256: hash(item.context_sha256, "reservation.context_sha256"),
    request_sha256: item.request_sha256 === null ? null : hash(item.request_sha256, "reservation.request_sha256"),
    terminal_reason: nullableText(item.terminal_reason, "reservation.terminal_reason")
  };
}

export function parseJobReport(value: unknown): JobReport {
  const raw = record(value, "report");
  if (raw.object !== "token_governor.report" || raw.schema_version !== 1 || raw.content_included !== false) invalid("report identity");
  const sourceJob = record(raw.job, "job");
  const job = parseJobView(sourceJob);
  const policy = record(sourceJob.policy, "job.policy");
  const pricing = record(sourceJob.pricing, "job.pricing");
  const rates = record(pricing.rates_micro_usd_per_million_tokens, "job.pricing.rates");
  if (!Array.isArray(raw.requests)) invalid("requests");
  const requests = raw.requests.map((value): ReportRequest => {
    const request = record(value, "request");
    const usage = request.usage === null ? null : record(request.usage, "request.usage");
    return {
      sequence: integer(request.sequence, "request.sequence"),
      request_id: text(request.request_id, "request.request_id"),
      phase: phase(request.phase), status: text(request.status, "request.status"),
      started_at: timestamp(request.started_at, "request.started_at"),
      request_fingerprint: hash(request.request_fingerprint, "request.request_fingerprint"),
      outcome_code: nullableText(request.outcome_code, "request.outcome_code"),
      reason: nullableText(request.reason, "request.reason"),
      reservation: parseReservation(request.reservation),
      usage: usage === null ? null : {
        input_tokens: integer(usage.input_tokens, "usage.input_tokens"),
        cached_input_tokens: integer(usage.cached_input_tokens, "usage.cached_input_tokens"),
        cache_write_input_tokens: integer(usage.cache_write_input_tokens, "usage.cache_write_input_tokens"),
        output_tokens: integer(usage.output_tokens, "usage.output_tokens"),
        reasoning_output_tokens: integer(usage.reasoning_output_tokens, "usage.reasoning_output_tokens"),
        total_tokens: usage.total_tokens === null ? null : integer(usage.total_tokens, "usage.total_tokens")
      },
      provider_response_id: nullableText(request.provider_response_id, "request.provider_response_id")
    };
  });
  if (requests.length !== job.requests.length || requests.some((request, index) => {
    const summary = job.requests[index];
    return request.sequence !== summary.sequence || request.request_id !== summary.request_id ||
      request.phase !== summary.phase || request.status !== summary.status ||
      (request.reservation !== null && (request.reservation.request_id !== request.request_id || request.reservation.phase !== request.phase));
  })) invalid("request agreement");
  return {
    object: "token_governor.report", schema_version: 1,
    generated_at: timestamp(raw.generated_at, "generated_at"), content_included: false,
    job: {
      ...job, created_at: timestamp(sourceJob.created_at, "job.created_at"),
      policy: {
        ...job.policy,
        final_input_token_limit: integer(policy.final_input_token_limit, "policy.final_input_token_limit"),
        minimum_final_output_tokens: integer(policy.minimum_final_output_tokens, "policy.minimum_final_output_tokens")
      },
      pricing: {
        provider: text(pricing.provider, "pricing.provider"), model: text(pricing.model, "pricing.model"),
        service_tier: text(pricing.service_tier, "pricing.service_tier"),
        request_service_tier: text(pricing.request_service_tier, "pricing.request_service_tier"),
        processing_region: text(pricing.processing_region, "pricing.processing_region"),
        rate_card_version: text(pricing.rate_card_version, "pricing.rate_card_version"),
        rate_card_source: text(pricing.rate_card_source, "pricing.rate_card_source"),
        rate_card_effective_at: text(pricing.rate_card_effective_at, "pricing.rate_card_effective_at"),
        rates_micro_usd_per_million_tokens: {
          uncachedInputMicroUsdPerMillionTokens: integer(rates.uncachedInputMicroUsdPerMillionTokens, "rates.uncached"),
          cachedInputMicroUsdPerMillionTokens: integer(rates.cachedInputMicroUsdPerMillionTokens, "rates.cached"),
          cacheWriteInputMicroUsdPerMillionTokens: integer(rates.cacheWriteInputMicroUsdPerMillionTokens, "rates.cache_write"),
          outputMicroUsdPerMillionTokens: integer(rates.outputMicroUsdPerMillionTokens, "rates.output")
        }
      }
    },
    requests
  };
}

export function jobReportMarkdown(report: JobReport): string {
  const escape = (value: string): string => value.replace(/[\\`*_\[\]<>#|]/g, "\\$&").replace(/[\r\n]+/g, " ");
  const { job } = report;
  const lines = [
    `# Governor job report: ${escape(job.id)}`, "",
    `- Status: ${escape(job.status)}`,
    `- Created: ${escape(job.created_at)}`,
    `- Generated: ${escape(report.generated_at)}`,
    `- Model: ${escape(job.pricing.model)}`,
    `- Rate card: ${escape(job.pricing.rate_card_version)}`,
    `- Budget: $${escape(job.policy.budget_usd)}`,
    `- Settled: $${escape(job.accounting.settled_usd)}`,
    `- Held reservations: $${escape(job.accounting.reserved_usd)}`,
    `- Uncommitted: $${escape(job.accounting.uncommitted_usd)}`,
    `- Protected final reserve: $${escape(job.policy.final_reserve_usd)}`,
    `- Responses: ${job.accounting.responses_started}/${job.policy.max_responses}`,
    `- Final validation: ${job.completion_accepted === null ? escape(job.pending_final_validation_request_id ?? "none") : job.completion_accepted ? "accepted" : "rejected"}`,
    "", "This is a local Governor accounting record, not a provider invoice or tamperproof proof. Prompts and model outputs are excluded.",
    "", "## Requests", "",
    "| # | Request | Phase | Status | Input tokens | Output cap | Reserved cap | Settled |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |"
  ];
  for (const request of report.requests) {
    const reservation = request.reservation;
    lines.push(`| ${request.sequence} | ${escape(request.request_id)} | ${request.phase} | ${escape(request.status)} | ${reservation?.exact_input_tokens ?? "—"} | ${reservation?.max_output_tokens ?? "—"} | ${reservation ? `$${reservation.reserved_usd}` : "—"} | ${reservation?.settled_usd === undefined || reservation.settled_usd === null ? "—" : `$${reservation.settled_usd}`} |`);
  }
  if (report.requests.length === 0) lines.push("", "No response attempts have been recorded.");
  for (const request of report.requests) {
    lines.push("", `### ${request.sequence}. ${escape(request.request_id)}`, "",
      `- Started: ${escape(request.started_at)}`,
      `- Intent fingerprint: ${request.request_fingerprint}`);
    if (request.reason) lines.push(`- Reason: ${escape(request.reason)}`);
    if (request.outcome_code) lines.push(`- Outcome code: ${escape(request.outcome_code)}`);
    if (request.provider_response_id) lines.push(`- Provider response: ${escape(request.provider_response_id)}`);
    if (request.usage) lines.push(`- Reported usage: ${request.usage.input_tokens} input / ${request.usage.output_tokens} output tokens`);
    if (request.status === "in_progress") lines.push("- This request was still running when the report was generated.");
    if (request.status === "unresolved") lines.push("- Provider usage is unresolved; its reservation remains held.");
  }
  return `${lines.join("\n")}\n`;
}
