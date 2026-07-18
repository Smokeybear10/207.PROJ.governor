import { GovernorApiError } from "./apiClient";

const WATCH_COMMITTED_BPS = 7_000;
const AT_RISK_COMMITTED_BPS = 9_000;

export type RiskBand = "SAFE" | "WATCH" | "AT_RISK";

export type JobRequestSummary = {
  sequence: number;
  request_id: string;
  phase: "work" | "final";
  status: string;
  started_at: string;
};

export type JobView = {
  id: string;
  status: string;
  policy: {
    budget_micro_usd: number;
    budget_usd: string;
    final_reserve_micro_usd: number;
    final_reserve_usd: string;
    max_responses: number;
  };
  accounting: {
    settled_micro_usd: number;
    settled_usd: string;
    reserved_micro_usd: number;
    reserved_usd: string;
    committed_micro_usd: number;
    committed_usd: string;
    uncommitted_micro_usd: number;
    uncommitted_usd: string;
    available_for_work_usd: string;
    responses_started: number;
  };
  pending_final_validation_request_id: string | null;
  completion_accepted: boolean | null;
  requests: JobRequestSummary[];
};

export type SubmissionResponse = {
  model: string;
  status: string;
  output: unknown[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  } | null;
};

export type SubmissionExecution = {
  status: string;
  reason?: string;
  response?: SubmissionResponse | null;
  reservation?: {
    exact_input_tokens: number;
    max_output_tokens: number;
    reserved_usd: string;
    settled_usd: string | null;
  };
};

export type ResponseSubmission = {
  execution: SubmissionExecution;
  job: JobView;
};

function invalidApiResponse(pathName: string, expected: string): never {
  throw new GovernorApiError(
    `Governor response field "${pathName}" must be ${expected}.`,
    200,
    "INVALID_RESPONSE"
  );
}

function apiRecord(
  value: unknown,
  pathName: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidApiResponse(pathName, "an object");
  }
  return value as Record<string, unknown>;
}

function apiString(value: unknown, pathName: string): string {
  if (typeof value !== "string") {
    invalidApiResponse(pathName, "a string");
  }
  return value;
}

function apiNumber(value: unknown, pathName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidApiResponse(pathName, "a finite number");
  }
  return value;
}

function apiNonNegativeInteger(value: unknown, pathName: string): number {
  const parsed = apiNumber(value, pathName);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    invalidApiResponse(pathName, "a non-negative safe integer");
  }
  return parsed;
}

function apiNullableString(value: unknown, pathName: string): string | null {
  if (value === null) {
    return null;
  }
  return apiString(value, pathName);
}

export function parseJobView(value: unknown): JobView {
  const record = apiRecord(value, "job");
  const policy = apiRecord(record.policy, "job.policy");
  const accounting = apiRecord(record.accounting, "job.accounting");
  if (!Array.isArray(record.requests)) {
    invalidApiResponse("job.requests", "an array");
  }
  const completionAccepted =
    record.completion_accepted === null
      ? null
      : typeof record.completion_accepted === "boolean"
        ? record.completion_accepted
        : invalidApiResponse("job.completion_accepted", "a boolean or null");

  return {
    id: apiString(record.id, "job.id"),
    status: apiString(record.status, "job.status"),
    policy: {
      budget_micro_usd: apiNonNegativeInteger(
        policy.budget_micro_usd,
        "job.policy.budget_micro_usd"
      ),
      budget_usd: apiString(policy.budget_usd, "job.policy.budget_usd"),
      final_reserve_micro_usd: apiNonNegativeInteger(
        policy.final_reserve_micro_usd,
        "job.policy.final_reserve_micro_usd"
      ),
      final_reserve_usd: apiString(
        policy.final_reserve_usd,
        "job.policy.final_reserve_usd"
      ),
      max_responses: apiNonNegativeInteger(
        policy.max_responses,
        "job.policy.max_responses"
      )
    },
    accounting: {
      settled_micro_usd: apiNonNegativeInteger(
        accounting.settled_micro_usd,
        "job.accounting.settled_micro_usd"
      ),
      settled_usd: apiString(
        accounting.settled_usd,
        "job.accounting.settled_usd"
      ),
      reserved_micro_usd: apiNonNegativeInteger(
        accounting.reserved_micro_usd,
        "job.accounting.reserved_micro_usd"
      ),
      reserved_usd: apiString(
        accounting.reserved_usd,
        "job.accounting.reserved_usd"
      ),
      committed_micro_usd: apiNonNegativeInteger(
        accounting.committed_micro_usd,
        "job.accounting.committed_micro_usd"
      ),
      committed_usd: apiString(
        accounting.committed_usd,
        "job.accounting.committed_usd"
      ),
      uncommitted_micro_usd: apiNonNegativeInteger(
        accounting.uncommitted_micro_usd,
        "job.accounting.uncommitted_micro_usd"
      ),
      uncommitted_usd: apiString(
        accounting.uncommitted_usd,
        "job.accounting.uncommitted_usd"
      ),
      available_for_work_usd: apiString(
        accounting.available_for_work_usd,
        "job.accounting.available_for_work_usd"
      ),
      responses_started: apiNonNegativeInteger(
        accounting.responses_started,
        "job.accounting.responses_started"
      )
    },
    pending_final_validation_request_id: apiNullableString(
      record.pending_final_validation_request_id,
      "job.pending_final_validation_request_id"
    ),
    completion_accepted: completionAccepted,
    requests: record.requests.map((rawRequest, index) => {
      const request = apiRecord(rawRequest, `job.requests[${index}]`);
      const phase = request.phase;
      if (phase !== "work" && phase !== "final") {
        invalidApiResponse(
          `job.requests[${index}].phase`,
          '"work" or "final"'
        );
      }
      return {
        sequence: apiNonNegativeInteger(
          request.sequence,
          `job.requests[${index}].sequence`
        ),
        request_id: apiString(
          request.request_id,
          `job.requests[${index}].request_id`
        ),
        phase,
        status: apiString(
          request.status,
          `job.requests[${index}].status`
        ),
        started_at: apiString(
          request.started_at,
          `job.requests[${index}].started_at`
        )
      };
    })
  };
}

export function parseSubmission(value: unknown): ResponseSubmission {
  const record = apiRecord(value, "submission");
  const execution = apiRecord(record.execution, "submission.execution");
  const parsed: SubmissionExecution = {
    status: apiString(execution.status, "submission.execution.status")
  };

  if (execution.reason !== undefined) {
    parsed.reason = apiString(
      execution.reason,
      "submission.execution.reason"
    );
  }
  if (execution.response !== undefined && execution.response !== null) {
    const response = apiRecord(
      execution.response,
      "submission.execution.response"
    );
    if (!Array.isArray(response.output)) {
      invalidApiResponse(
        "submission.execution.response.output",
        "an array"
      );
    }
    let usage: SubmissionResponse["usage"] = null;
    if (response.usage !== undefined && response.usage !== null) {
      const rawUsage = apiRecord(
        response.usage,
        "submission.execution.response.usage"
      );
      usage = {
        input_tokens: apiNonNegativeInteger(
          rawUsage.input_tokens,
          "submission.execution.response.usage.input_tokens"
        ),
        output_tokens: apiNonNegativeInteger(
          rawUsage.output_tokens,
          "submission.execution.response.usage.output_tokens"
        ),
        total_tokens: apiNonNegativeInteger(
          rawUsage.total_tokens,
          "submission.execution.response.usage.total_tokens"
        )
      };
    }
    parsed.response = {
      model: apiString(
        response.model,
        "submission.execution.response.model"
      ),
      status: apiString(
        response.status,
        "submission.execution.response.status"
      ),
      output: response.output,
      usage
    };
  } else {
    parsed.response = null;
  }

  if (execution.reservation !== undefined) {
    const reservation = apiRecord(
      execution.reservation,
      "submission.execution.reservation"
    );
    parsed.reservation = {
      exact_input_tokens: apiNonNegativeInteger(
        reservation.exact_input_tokens,
        "submission.execution.reservation.exact_input_tokens"
      ),
      max_output_tokens: apiNonNegativeInteger(
        reservation.max_output_tokens,
        "submission.execution.reservation.max_output_tokens"
      ),
      reserved_usd: apiString(
        reservation.reserved_usd,
        "submission.execution.reservation.reserved_usd"
      ),
      settled_usd: apiNullableString(
        reservation.settled_usd,
        "submission.execution.reservation.settled_usd"
      )
    };
  }

  return {
    execution: parsed,
    job: parseJobView(record.job)
  };
}

export function riskBand(job: JobView): RiskBand {
  const budget = Math.max(1, job.policy.budget_micro_usd);
  const committedBps = Math.floor(
    (job.accounting.committed_micro_usd * 10_000) / budget
  );
  if (committedBps >= AT_RISK_COMMITTED_BPS) {
    return "AT_RISK";
  }
  if (committedBps >= WATCH_COMMITTED_BPS) {
    return "WATCH";
  }
  return "SAFE";
}

export function usd(value: string): string {
  return `$${value}`;
}

export function collectOutputText(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const piece of content) {
      if (
        typeof piece === "object" &&
        piece !== null &&
        (piece as { type?: unknown }).type === "output_text" &&
        typeof (piece as { text?: unknown }).text === "string"
      ) {
        parts.push((piece as { text: string }).text);
      }
    }
  }
  return parts.join("\n").trim();
}

export function promptResultMarkdown(
  jobId: string,
  requestId: string,
  phase: string,
  prompt: string,
  submission: ResponseSubmission
): string {
  const execution = submission.execution;
  const response = execution.response ?? null;
  const reservation = execution.reservation;
  const lines = [
    `# Governor response \`${requestId}\``,
    "",
    `- Job: \`${jobId}\``,
    `- Phase: ${phase}`,
    `- Execution: ${execution.status}${execution.reason ? ` (${execution.reason})` : ""}`
  ];

  if (response) {
    lines.push(`- Model: ${response.model}`);
    if (response.usage) {
      lines.push(
        `- Tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`
      );
    }
  }
  if (reservation) {
    lines.push(
      `- Reserved: ${usd(reservation.reserved_usd)}` +
        (reservation.settled_usd === null
          ? " (not settled)"
          : `, settled: ${usd(reservation.settled_usd)}`)
    );
  }

  lines.push("", "## Prompt", "", prompt, "", "## Answer", "");
  const answer = response === null ? "" : collectOutputText(response.output);
  if (answer) {
    lines.push(answer);
  } else if (response) {
    lines.push(
      "The response contained no plain text output. Raw output:",
      "",
      "```json",
      JSON.stringify(response.output, null, 2),
      "```"
    );
  } else {
    lines.push(
      "No provider response is available for this outcome. Check the " +
        "Governor output channel and the job panel."
    );
  }
  return `${lines.join("\n")}\n`;
}
