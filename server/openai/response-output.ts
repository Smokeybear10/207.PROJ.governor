import type { JsonObject } from "./responses-client.js";

export const MAX_OUTPUT_ITEMS = 64;
export const MAX_OUTPUT_DEPTH = 64;
export const MAX_OUTPUT_NODES = 10_000;
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_ARGUMENT_BYTES = 64 * 1024;
export const MAX_FINAL_FINDINGS = 50;
export const MAX_FINAL_CATEGORY_BYTES = 128;
export const MAX_FINAL_PATH_BYTES = 1_024;
export const MAX_FINAL_EXPLANATION_BYTES = 4 * 1024;
export const MAX_FINAL_MITIGATION_BYTES = 4 * 1024;

export class ResponseOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseOutputError";
  }
}

export type ParsedFunctionCall = {
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  readonly arguments: JsonObject;
  readonly rawArguments: string;
};

export type ParsedWorkOutput =
  | {
      readonly kind: "function_call";
      readonly call: ParsedFunctionCall;
      readonly replayItems: readonly JsonObject[];
    }
  | {
      readonly kind: "assistant_text";
      readonly text: string;
      readonly replayItems: readonly JsonObject[];
    };

export type FinalFindingSeverity = "P0" | "P1" | "P2" | "P3";

export type ParsedFinalFinding = {
  readonly category: string;
  readonly severity: FinalFindingSeverity;
  readonly path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly explanation: string;
  readonly suggested_mitigation: string;
};

export type ParsedFinalReview =
  | {
      readonly status: "clean";
    }
  | {
      readonly status: "findings";
      readonly findings: readonly ParsedFinalFinding[];
    };

export type ParsedFinalOutput = {
  readonly text: string;
  readonly review: ParsedFinalReview;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type JsonValidationFrame =
  | {
      readonly kind: "visit";
      readonly value: unknown;
      readonly depth: number;
    }
  | {
      readonly kind: "leave";
      readonly value: object;
    };

function stringByteLength(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertBoundedJson(value: unknown, label: string): void {
  try {
    const active = new Set<object>();
    const stack: JsonValidationFrame[] = [
      { kind: "visit", value, depth: 0 }
    ];
    let scheduledNodes = 1;
    let serializedBytes = 0;

    const addBytes = (bytes: number): void => {
      serializedBytes += bytes;
      if (serializedBytes > MAX_OUTPUT_BYTES) {
        throw new ResponseOutputError(
          `${label} exceeds the ${MAX_OUTPUT_BYTES}-byte serialized limit.`
        );
      }
    };

    const scheduleChildren = (count: number): void => {
      scheduledNodes += count;
      if (scheduledNodes > MAX_OUTPUT_NODES) {
        throw new ResponseOutputError(
          `${label} exceeds the ${MAX_OUTPUT_NODES}-node structural limit.`
        );
      }
    };

    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.kind === "leave") {
        active.delete(frame.value);
        continue;
      }

      if (frame.depth > MAX_OUTPUT_DEPTH) {
        throw new ResponseOutputError(
          `${label} exceeds the maximum structural depth of ${MAX_OUTPUT_DEPTH}.`
        );
      }

      const current = frame.value;
      if (current === null) {
        addBytes(4);
        continue;
      }
      if (typeof current === "string") {
        addBytes(stringByteLength(current));
        continue;
      }
      if (typeof current === "boolean") {
        addBytes(current ? 4 : 5);
        continue;
      }
      if (typeof current === "number") {
        if (!Number.isFinite(current)) {
          throw new ResponseOutputError(
            `${label} contains a non-finite number.`
          );
        }
        addBytes(Buffer.byteLength(JSON.stringify(current), "utf8"));
        continue;
      }
      if (typeof current !== "object") {
        throw new ResponseOutputError(
          `${label} is not JSON-compatible.`
        );
      }
      if (active.has(current)) {
        throw new ResponseOutputError(`${label} contains a cycle.`);
      }

      active.add(current);
      stack.push({ kind: "leave", value: current });

      if (Array.isArray(current)) {
        scheduleChildren(current.length);
        addBytes(2 + Math.max(0, current.length - 1));
        for (let index = current.length - 1; index >= 0; index -= 1) {
          stack.push({
            kind: "visit",
            value: current[index],
            depth: frame.depth + 1
          });
        }
        continue;
      }
      if (!isRecord(current)) {
        throw new ResponseOutputError(
          `${label} is not a plain JSON object.`
        );
      }

      const entries = Object.entries(current);
      scheduleChildren(entries.length);
      addBytes(2 + Math.max(0, entries.length - 1));
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index]!;
        addBytes(stringByteLength(key) + 1);
        stack.push({
          kind: "visit",
          value: child,
          depth: frame.depth + 1
        });
      }
    }
  } catch (error) {
    if (error instanceof ResponseOutputError) {
      throw error;
    }
    throw new ResponseOutputError(
      `${label} could not be validated as bounded JSON.`
    );
  }
}

function cloneOutput(output: unknown[]): JsonObject[] {
  try {
    if (
      !Array.isArray(output) ||
      output.length === 0 ||
      output.length > MAX_OUTPUT_ITEMS
    ) {
      throw new ResponseOutputError(
        `Response output must contain 1-${MAX_OUTPUT_ITEMS} items.`
      );
    }
    assertBoundedJson(output, "Response output");
    return structuredClone(output) as JsonObject[];
  } catch (error) {
    if (error instanceof ResponseOutputError) {
      throw error;
    }
    throw new ResponseOutputError(
      "Response output could not be safely cloned."
    );
  }
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  label: string
): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new ResponseOutputError(`${label} requires ${field}.`);
  }
  return value;
}

function requireBoundedString(
  record: Record<string, unknown>,
  field: string,
  label: string,
  maximumBytes: number
): string {
  const value = requireString(record, field, label).trim();
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new ResponseOutputError(
      `${label} ${field} exceeds ${maximumBytes} UTF-8 bytes.`
    );
  }
  return value;
}

function requireExactFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  label: string
): void {
  const expected = new Set(fields);
  if (
    Object.keys(record).length !== expected.size ||
    Object.keys(record).some((field) => !expected.has(field))
  ) {
    throw new ResponseOutputError(
      `${label} must contain exactly: ${fields.join(", ")}.`
    );
  }
}

function requirePositiveSafeInteger(
  record: Record<string, unknown>,
  field: string,
  label: string
): number {
  const value = record[field];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ResponseOutputError(
      `${label} ${field} must be a positive safe integer.`
    );
  }
  return value as number;
}

function parseArguments(rawArguments: string): JsonObject {
  if (Buffer.byteLength(rawArguments, "utf8") > MAX_ARGUMENT_BYTES) {
    throw new ResponseOutputError("Function-call arguments are too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new ResponseOutputError(
      "Function-call arguments must be valid JSON."
    );
  }
  if (!isRecord(parsed)) {
    throw new ResponseOutputError(
      "Function-call arguments must be a JSON object."
    );
  }
  assertBoundedJson(parsed, "Function-call arguments");
  return parsed;
}

function inspectOutput(output: unknown[]): {
  replayItems: readonly JsonObject[];
  calls: ParsedFunctionCall[];
  text: string;
  sawMessage: boolean;
} {
  const replayItems = Object.freeze(
    cloneOutput(output).map((item) => Object.freeze(item))
  );
  const calls: ParsedFunctionCall[] = [];
  const text: string[] = [];
  let sawMessage = false;

  for (const item of replayItems) {
    if (!isRecord(item) || typeof item.type !== "string") {
      throw new ResponseOutputError("Response output item is malformed.");
    }

    if (item.type === "reasoning") {
      requireString(item, "id", "Reasoning item");
      requireString(item, "encrypted_content", "Reasoning item");
      continue;
    }

    if (item.type === "function_call") {
      if (item.status !== "completed") {
        throw new ResponseOutputError(
          "Function-call output must be completed."
        );
      }
      const rawArguments = requireString(
        item,
        "arguments",
        "Function-call item"
      );
      calls.push(
        Object.freeze({
          id: requireString(item, "id", "Function-call item"),
          callId: requireString(item, "call_id", "Function-call item"),
          name: requireString(item, "name", "Function-call item"),
          arguments: Object.freeze(parseArguments(rawArguments)),
          rawArguments
        })
      );
      continue;
    }

    if (item.type === "message") {
      sawMessage = true;
      if (
        item.role !== "assistant" ||
        item.status !== "completed" ||
        !Array.isArray(item.content)
      ) {
        throw new ResponseOutputError("Assistant message is malformed.");
      }
      for (const content of item.content) {
        if (!isRecord(content) || typeof content.type !== "string") {
          throw new ResponseOutputError(
            "Assistant message content is malformed."
          );
        }
        if (content.type === "refusal") {
          throw new ResponseOutputError("Provider returned a refusal.");
        }
        if (
          content.type !== "output_text" ||
          typeof content.text !== "string"
        ) {
          throw new ResponseOutputError(
            "Assistant message contains an unsupported content type."
          );
        }
        text.push(content.text);
      }
      continue;
    }

    throw new ResponseOutputError(
      `Unsupported response output item type: ${item.type}.`
    );
  }

  return {
    replayItems,
    calls,
    text: text.join(""),
    sawMessage
  };
}

export function parseWorkOutput(output: unknown[]): ParsedWorkOutput {
  const inspected = inspectOutput(output);
  if (inspected.calls.length > 1) {
    throw new ResponseOutputError(
      "A governed work response may call at most one function."
    );
  }
  if (inspected.calls.length === 1) {
    if (inspected.sawMessage) {
      throw new ResponseOutputError(
        "A function call cannot be mixed with assistant text."
      );
    }
    return Object.freeze({
      kind: "function_call" as const,
      call: inspected.calls[0],
      replayItems: inspected.replayItems
    });
  }
  if (!inspected.sawMessage || !inspected.text.trim()) {
    throw new ResponseOutputError(
      "Work response contained neither a function call nor assistant text."
    );
  }
  return Object.freeze({
    kind: "assistant_text" as const,
    text: inspected.text,
    replayItems: inspected.replayItems
  });
}

export function extractFinalText(output: unknown[]): string {
  const inspected = inspectOutput(output);
  if (inspected.calls.length > 0) {
    throw new ResponseOutputError(
      "The final response cannot contain a function call."
    );
  }
  if (!inspected.sawMessage || !inspected.text.trim()) {
    throw new ResponseOutputError("The final response text is empty.");
  }
  return inspected.text;
}

function parseFinalFinding(
  value: unknown,
  index: number
): ParsedFinalFinding {
  const label = `Final finding ${index + 1}`;
  if (!isRecord(value)) {
    throw new ResponseOutputError(`${label} must be a JSON object.`);
  }
  requireExactFields(
    value,
    [
      "category",
      "severity",
      "path",
      "start_line",
      "end_line",
      "explanation",
      "suggested_mitigation"
    ],
    label
  );

  const severity = value.severity;
  if (
    severity !== "P0" &&
    severity !== "P1" &&
    severity !== "P2" &&
    severity !== "P3"
  ) {
    throw new ResponseOutputError(
      `${label} severity must be P0, P1, P2, or P3.`
    );
  }
  const startLine = requirePositiveSafeInteger(
    value,
    "start_line",
    label
  );
  const endLine = requirePositiveSafeInteger(value, "end_line", label);
  if (startLine > endLine) {
    throw new ResponseOutputError(
      `${label} start_line must be less than or equal to end_line.`
    );
  }

  return Object.freeze({
    category: requireBoundedString(
      value,
      "category",
      label,
      MAX_FINAL_CATEGORY_BYTES
    ),
    severity,
    path: requireBoundedString(
      value,
      "path",
      label,
      MAX_FINAL_PATH_BYTES
    ),
    start_line: startLine,
    end_line: endLine,
    explanation: requireBoundedString(
      value,
      "explanation",
      label,
      MAX_FINAL_EXPLANATION_BYTES
    ),
    suggested_mitigation: requireBoundedString(
      value,
      "suggested_mitigation",
      label,
      MAX_FINAL_MITIGATION_BYTES
    )
  });
}

function parseFinalReviewText(text: string): ParsedFinalReview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ResponseOutputError(
      "The final response text must be valid JSON."
    );
  }
  assertBoundedJson(parsed, "Final review");
  if (!isRecord(parsed)) {
    throw new ResponseOutputError(
      "The final review must be a JSON object."
    );
  }

  if (parsed.status === "clean") {
    requireExactFields(parsed, ["status"], "Clean final review");
    return Object.freeze({ status: "clean" as const });
  }
  if (parsed.status !== "findings") {
    throw new ResponseOutputError(
      'The final review status must be "clean" or "findings".'
    );
  }
  requireExactFields(
    parsed,
    ["status", "findings"],
    "Findings final review"
  );
  if (
    !Array.isArray(parsed.findings) ||
    parsed.findings.length === 0 ||
    parsed.findings.length > MAX_FINAL_FINDINGS
  ) {
    throw new ResponseOutputError(
      `A findings final review must contain 1-${MAX_FINAL_FINDINGS} findings.`
    );
  }
  return Object.freeze({
    status: "findings" as const,
    findings: Object.freeze(parsed.findings.map(parseFinalFinding))
  });
}

export function parseFinalReviewOutput(
  output: unknown[]
): ParsedFinalOutput {
  const text = extractFinalText(output);
  return Object.freeze({
    text,
    review: parseFinalReviewText(text)
  });
}
