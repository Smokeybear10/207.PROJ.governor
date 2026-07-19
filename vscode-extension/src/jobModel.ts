import { GovernorApiError } from "./apiClient";

const WATCH_COMMITTED_BPS = 7_000;
const AT_RISK_COMMITTED_BPS = 9_000;

export type RiskBand = "SAFE" | "WATCH" | "AT_RISK";

export type JobSummary = {
  id: string;
  created_at: string;
  status: string;
  budget_usd: string;
  settled_usd: string;
  reserved_usd: string;
  responses_started: number;
  max_responses: number;
};

export type JobList = {
  object: "list";
  data: JobSummary[];
  has_more: boolean;
  next_after: string | null;
};

export type JobControls = {
  canSubmit: boolean;
  canFinalize: boolean;
  canViewResponses: boolean;
  message: string;
};

export type JobRequestSummary = {
  sequence: number;
  request_id: string;
  request_fingerprint: string;
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
    request_id: string;
    phase: "work" | "final";
    exact_input_tokens: number;
    max_output_tokens: number;
    reserved_usd: string;
    settled_usd: string | null;
  };
};

export type ResponseSubmission = {
  request_fingerprint: string;
  execution: SubmissionExecution;
  job: JobView;
};

export type SavedResponse =
  | { status: "pending" | "missing"; message: string }
  | { status: "ready"; request: JobRequestSummary; submission: ResponseSubmission };

function invalidApiResponse(pathName: string, expected: string): never {
  throw new GovernorApiError(
    `Governor response field "${pathName}" must be ${expected}.`,
    200,
    "INVALID_RESPONSE"
  );
}

function apiFingerprint(value: unknown, pathName: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    invalidApiResponse(pathName, "a SHA-256 fingerprint");
  }
  return value;
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

export function parseJobList(value: unknown): JobList {
  const record = apiRecord(value, "jobs");
  if (record.object !== "list") invalidApiResponse("jobs.object", '"list"');
  if (!Array.isArray(record.data)) invalidApiResponse("jobs.data", "an array");
  if (typeof record.has_more !== "boolean") invalidApiResponse("jobs.has_more", "a boolean");
  const data = record.data.map((value, index) => {
    const path = `jobs.data[${index}]`;
    const item = apiRecord(value, path);
    const id = apiString(item.id, `${path}.id`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
      invalidApiResponse(`${path}.id`, "a valid job ID");
    }
    const createdAt = apiString(item.created_at, `${path}.created_at`);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
      !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
      invalidApiResponse(`${path}.created_at`, "an ISO timestamp");
    }
    const status = apiString(item.status, `${path}.status`);
    if (!status.trim()) invalidApiResponse(`${path}.status`, "a non-empty status");
    const amount = (field: string): string => {
      const parsed = apiString(item[field], `${path}.${field}`);
      if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(parsed)) {
        invalidApiResponse(`${path}.${field}`, "a non-negative decimal USD amount");
      }
      return parsed;
    };
    const maxResponses = apiNonNegativeInteger(item.max_responses, `${path}.max_responses`);
    const responsesStarted = apiNonNegativeInteger(item.responses_started, `${path}.responses_started`);
    if (maxResponses < 1 || responsesStarted > maxResponses) {
      invalidApiResponse(path, "valid response counts");
    }
    return {
      id,
      created_at: createdAt,
      status,
      budget_usd: amount("budget_usd"),
      settled_usd: amount("settled_usd"),
      reserved_usd: amount("reserved_usd"),
      responses_started: responsesStarted,
      max_responses: maxResponses
    };
  });
  if (new Set(data.map((job) => job.id)).size !== data.length) {
    invalidApiResponse("jobs.data", "jobs with unique IDs");
  }
  const nextAfter = apiNullableString(record.next_after, "jobs.next_after");
  if (record.has_more ? data.length === 0 || nextAfter !== data.at(-1)?.id : nextAfter !== null) {
    invalidApiResponse("jobs.next_after", "the last job ID when more jobs exist, or null");
  }
  return { object: "list", data, has_more: record.has_more, next_after: nextAfter };
}

export function jobControls(job: JobView | null): JobControls {
  const controls: JobControls = {
    canSubmit: false,
    canFinalize: false,
    canViewResponses: job?.requests.some((request) => request.status !== "in_progress") ?? false,
    message: "Create or choose a saved job to send a prompt."
  };
  if (!job) return controls;
  if (job.requests.some((request) => request.status === "in_progress") || job.status === "response_in_flight") {
    return { ...controls, message: "Wait for the current request to finish. Its response will appear in Saved responses." };
  }
  if (job.status === "reconciliation_required" || job.requests.some((request) => request.status === "unresolved")) {
    return { ...controls, message: "Spending is blocked while provider usage is unresolved. The reservation is still held. Review Saved responses; this version cannot reconcile the call automatically." };
  }
  if (job.status === "validation_required") {
    const pending = job.requests.find((request) => request.request_id === job.pending_final_validation_request_id);
    const canFinalize = pending?.phase === "final" && pending.status === "settled";
    return {
      ...controls,
      canFinalize,
      message: canFinalize
        ? "Review the saved final response, then choose Finalize to accept or reject it."
        : "The pending final response is unavailable. Refresh the job before continuing."
    };
  }
  if (job.status === "completed" || job.status === "rejected") {
    return {
      ...controls,
      message: job.status === "completed"
        ? "This job is complete. Review Saved responses or create a new job."
        : "The final response was rejected and this job is closed. Review Saved responses or create a new job."
    };
  }
  if (job.status !== "open" || job.pending_final_validation_request_id !== null) {
    return { ...controls, message: "This job is not ready for new requests. Refresh it or choose another saved job." };
  }
  if (job.accounting.responses_started >= job.policy.max_responses) {
    return { ...controls, message: "This job has reached its response limit. Review Saved responses or create a new job." };
  }
  if (job.accounting.uncommitted_micro_usd <= 0) {
    return { ...controls, message: "This job has no uncommitted budget. Review Saved responses or create a new job." };
  }
  const finalOnly = job.accounting.responses_started === job.policy.max_responses - 1 ||
    Number(job.accounting.available_for_work_usd) <= 0;
  return {
    ...controls,
    canSubmit: true,
    message: finalOnly
      ? "Only a final response is available. Choose the final phase when sending your prompt."
      : "Send a prompt through this job or review its saved responses."
  };
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
        request_fingerprint: apiFingerprint(request.request_fingerprint, `job.requests[${index}].request_fingerprint`),
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
    if (reservation.phase !== "work" && reservation.phase !== "final") {
      invalidApiResponse("submission.execution.reservation.phase", '"work" or "final"');
    }
    parsed.reservation = {
      request_id: apiString(reservation.request_id, "submission.execution.reservation.request_id"),
      phase: reservation.phase,
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
    request_fingerprint: apiFingerprint(record.request_fingerprint, "submission.request_fingerprint"),
    execution: parsed,
    job: parseJobView(record.job)
  };
}

export async function loadSavedResponse(
  jobId: string,
  requestId: string,
  read: (requestPath: string) => Promise<unknown>
): Promise<SavedResponse> {
  const jobPath = `/v1/jobs/${encodeURIComponent(jobId)}`;
  const job = parseJobView(await read(jobPath));
  if (job.id !== jobId) {
    throw new GovernorApiError("The service returned a different job.", 200, "INVALID_RESPONSE");
  }
  const request = job.requests.find((item) => item.request_id === requestId);
  if (!request) return {
    status: "missing",
    message: `No saved attempt for ${requestId} is visible yet. Check this job's saved responses before sending another request.`
  };
  if (request.status === "in_progress") return {
    status: "pending",
    message: `${requestId} is still running. Its result will appear in Saved Responses when it finishes. No new request was sent.`
  };
  const submission = parseSubmission(await read(`${jobPath}/responses/${encodeURIComponent(requestId)}`));
  const saved = submission.job.requests.find((item) => item.request_id === requestId);
  const reservation = submission.execution.reservation;
  if (submission.job.id !== jobId || !saved || saved.phase !== request.phase ||
    saved.status !== submission.execution.status ||
    saved.request_fingerprint !== request.request_fingerprint ||
    submission.request_fingerprint !== request.request_fingerprint ||
    (reservation && (reservation.request_id !== requestId || reservation.phase !== request.phase))) {
    throw new GovernorApiError("The saved response does not match this request.", 200, "INVALID_RESPONSE");
  }
  return { status: "ready", request: saved, submission };
}

export function riskBand(job: JobView): RiskBand {
  if (job.status === "reconciliation_required" || job.requests.some((request) => request.status === "unresolved")) {
    return "AT_RISK";
  }
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

export function savedResponseMarkdown(
  jobId: string,
  request: JobRequestSummary,
  submission: ResponseSubmission
): string {
  const escape = (value: string): string => value.replace(/[\\`*_\[\]<>#|]/g, "\\$&").replace(/[\r\n]+/g, " ");
  const { execution } = submission;
  const response = execution.response;
  const descriptions: Record<string, string> = {
    settled: "The response was saved and its reported usage was settled.",
    denied: "Governor blocked this request before dispatch. No provider response was created.",
    preflight_failed: "Preflight failed before dispatch. Submit a new request ID to retry.",
    provider_rejected: "The provider rejected this request. No output was accepted.",
    provider_stopped: "The provider stopped before completing the response. Reported usage was settled.",
    unresolved: "The outcome is unresolved and the reservation remains held. Do not resend this request. This version cannot reconcile the call automatically."
  };
  const lines = [
    `# Saved Governor response: ${escape(request.request_id)}`,
    "",
    `- Job: ${escape(jobId)}`,
    `- Phase: ${escape(request.phase)}`,
    `- Started: ${escape(request.started_at)}`,
    `- Execution: ${escape(execution.status)}${execution.reason ? ` (${escape(execution.reason)})` : ""}`,
    "",
    Object.hasOwn(descriptions, execution.status)
      ? descriptions[execution.status]
      : "This receipt records an unrecognized outcome. Review the job before continuing."
  ];
  if (response) {
    lines.push("", `- Model: ${escape(response.model)}`, `- Provider status: ${escape(response.status)}`);
    if (response.usage) lines.push(`- Tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`);
  }
  if (execution.reservation) {
    lines.push(`- Reserved: ${escape(usd(execution.reservation.reserved_usd))}`);
    lines.push(execution.reservation.settled_usd === null
      ? execution.status === "unresolved" ? "- Settlement: unresolved" : "- Settlement: no usage charge recorded"
      : `- Settled: ${escape(usd(execution.reservation.settled_usd))}`);
  }
  lines.push("", "The original prompt is not stored in this receipt.", "", "## Output", "");
  if (!response) {
    lines.push("No provider output was saved for this outcome.");
  } else {
    const answer = collectOutputText(response.output);
    if (answer) {
      lines.push(answer);
    } else {
      const raw = JSON.stringify(response.output, null, 2);
      const longestFence = (raw.match(/`+/g) ?? []).reduce((longest, match) => Math.max(longest, match.length), 2);
      const fence = "`".repeat(longestFence + 1);
      lines.push("No plain text was returned. Saved raw output:", "", `${fence}json`, raw, fence);
    }
  }
  return `${lines.join("\n")}\n`;
}
