import { createHash } from "node:crypto";
import {
  assertGovernor,
  requireNonNegativeSafeInteger,
  requirePositiveSafeInteger
} from "./errors.js";

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const RELEVANT_ERROR_PATTERN =
  /(?:\b(?:assertionerror|typeerror|referenceerror|rangeerror|syntaxerror|exception|panic|fatal|timeout)\b|\berror\s*:|\bexpected\b|\breceived\b|\bactual\b|timed out)/i;
const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?-----END \1-----/gi;
const AUTHORIZATION_PATTERN =
  /(\bauthorization\b\s*[:=]\s*(?:bearer|basic)\s+)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;#\r\n]+)/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /((?:["']?)(?:(?:[a-z][a-z0-9_]{0,127}_)?(?:token|secret|password|api_key)|aws_access_key_id|aws_secret_access_key|aws_session_token)(?:["']?)\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;#\r\n]+)/gi;
const OPENAI_KEY_PATTERN = /\bsk-[a-z0-9_-]{12,}\b/gi;
const GITHUB_KEY_PATTERN =
  /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})\b/gi;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;

export const MAX_TEST_LOG_BYTES = 4 * 1024 * 1024;
export const REDACTION_PLACEHOLDER = "[REDACTED]";
export const REDACTION_DISCLOSURE =
  "Potential credentials were replaced before persistence or model exposure.";

export interface ArtifactEstimate {
  readonly bytes: number;
  readonly estimatedTokens: number;
}

export interface RawLogArtifact extends ArtifactEstimate {
  readonly sha256: string;
}

export interface RedactionMetadata {
  readonly applied: boolean;
  readonly count: number;
  readonly disclosure: string;
}

export interface RedactedText {
  readonly text: string;
  readonly redaction: RedactionMetadata;
}

export interface FailingTestEntry {
  readonly name: string;
  readonly firstLine: number;
  readonly occurrences: number;
}

export interface RelevantErrorEntry {
  readonly text: string;
  readonly firstLine: number;
  readonly occurrences: number;
}

export interface TestLogReductionOptions {
  readonly contextLines?: number;
  readonly maxExcerptLines?: number;
  readonly maxFailingTests?: number;
  readonly maxRelevantErrorLines?: number;
  readonly redactionsAlreadyApplied?: number;
}

export interface ReducedTestLog {
  readonly exitCode: number;
  readonly text: string;
  readonly failingTests: readonly FailingTestEntry[];
  readonly relevantErrorLines: readonly RelevantErrorEntry[];
  readonly rawArtifact: RawLogArtifact;
  readonly reducedArtifact: ArtifactEstimate;
  readonly redaction: RedactionMetadata;
  readonly truncated: boolean;
  readonly omittedOriginalLines: number;
  readonly omittedFailingTests: number;
  readonly omittedRelevantErrorLines: number;
}

function estimate(bytes: number): ArtifactEstimate {
  return Object.freeze({
    bytes,
    estimatedTokens: Math.ceil(bytes / 4)
  });
}

function replacementFor(value: string): string {
  const quote = value.at(0);
  return quote === '"' || quote === "'" || quote === "`"
    ? `${quote}${REDACTION_PLACEHOLDER}${quote}`
    : REDACTION_PLACEHOLDER;
}

export function redactSensitiveText(value: string): RedactedText {
  assertGovernor(
    typeof value === "string",
    "INVALID_ARGUMENT",
    "value must be a string."
  );

  let count = 0;
  let text = value.replace(PRIVATE_KEY_BLOCK_PATTERN, () => {
    count += 1;
    return REDACTION_PLACEHOLDER;
  });
  text = text.replace(
    AUTHORIZATION_PATTERN,
    (_match, prefix: string, secret: string) => {
      count += 1;
      return `${prefix}${replacementFor(secret)}`;
    }
  );
  text = text.replace(
    SECRET_ASSIGNMENT_PATTERN,
    (_match, prefix: string, secret: string) => {
      count += 1;
      return `${prefix}${replacementFor(secret)}`;
    }
  );
  for (const pattern of [
    OPENAI_KEY_PATTERN,
    GITHUB_KEY_PATTERN,
    AWS_ACCESS_KEY_PATTERN
  ]) {
    text = text.replace(pattern, () => {
      count += 1;
      return REDACTION_PLACEHOLDER;
    });
  }

  return Object.freeze({
    text,
    redaction: Object.freeze({
      applied: count > 0,
      count,
      disclosure: REDACTION_DISCLOSURE
    })
  });
}

function extractFailingTestName(line: string): string | null {
  const patterns = [
    /^\s*FAIL\s+(.+?)\s*$/,
    /^\s*FAILED\s+(.+?)(?:\s+-\s+.*)?$/,
    /^\s*(?:\u00d7|\u2717|\u2718)\s+(.+?)\s*$/,
    /^\s*\u25cf\s+(.+?)\s*$/,
    /^\s*not ok(?:\s+\d+)?\s*[-:]?\s*(.+?)\s*$/
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(line);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function collectEntries<T extends { firstLine: number; occurrences: number }>(
  lines: readonly string[],
  extract: (line: string) => string | null,
  create: (value: string, firstLine: number) => T
): { entries: T[]; anchors: number[] } {
  const byValue = new Map<string, T>();
  const anchors: number[] = [];
  lines.forEach((line, index) => {
    const value = extract(line);
    if (value === null) {
      return;
    }
    anchors.push(index);
    const existing = byValue.get(value);
    if (existing === undefined) {
      byValue.set(value, create(value, index + 1));
    } else {
      Object.assign(existing, {
        occurrences: existing.occurrences + 1
      });
    }
  });
  return { entries: [...byValue.values()], anchors };
}

function selectedLineIndexes(
  lineCount: number,
  anchors: readonly number[],
  contextLines: number,
  maxExcerptLines: number
): number[] {
  const selected = new Set<number>();
  const add = (index: number): void => {
    if (
      selected.size < maxExcerptLines &&
      index >= 0 &&
      index < lineCount
    ) {
      selected.add(index);
    }
  };

  for (const anchor of anchors) {
    for (
      let index = anchor - contextLines;
      index <= anchor + contextLines;
      index += 1
    ) {
      add(index);
    }
  }

  const edgeLines =
    anchors.length === 0
      ? Math.ceil(maxExcerptLines / 2)
      : Math.min(10, Math.ceil(maxExcerptLines / 4));
  for (let index = 0; index < edgeLines; index += 1) {
    add(index);
  }
  for (
    let index = Math.max(0, lineCount - edgeLines);
    index < lineCount;
    index += 1
  ) {
    add(index);
  }

  return [...selected].sort((left, right) => left - right);
}

function formatExcerpts(
  lines: readonly string[],
  indexes: readonly number[]
): string[] {
  if (indexes.length === 0) {
    return ["(no log lines)"];
  }
  const output: string[] = [];
  let rangeStart = indexes[0];
  let previous = indexes[0];

  const appendRange = (start: number, end: number): void => {
    output.push(`--- lines ${start + 1}-${end + 1} ---`);
    for (let index = start; index <= end; index += 1) {
      output.push(lines[index]);
    }
  };

  for (let position = 1; position < indexes.length; position += 1) {
    const current = indexes[position];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    appendRange(rangeStart, previous);
    output.push(
      `[${current - previous - 1} original lines omitted]`
    );
    rangeStart = current;
    previous = current;
  }
  appendRange(rangeStart, previous);
  return output;
}

export function reduceTestLog(
  rawLog: string,
  exitCode: number,
  options: TestLogReductionOptions = {}
): ReducedTestLog {
  assertGovernor(
    typeof rawLog === "string",
    "INVALID_ARGUMENT",
    "rawLog must be a string."
  );
  requireNonNegativeSafeInteger(Math.abs(exitCode), "exitCode");
  assertGovernor(
    Number.isSafeInteger(exitCode),
    "INVALID_ARGUMENT",
    "exitCode must be a safe integer."
  );
  const inputBytes = Buffer.byteLength(rawLog, "utf8");
  assertGovernor(
    inputBytes <= MAX_TEST_LOG_BYTES,
    "INVALID_ARGUMENT",
    `rawLog exceeds the ${MAX_TEST_LOG_BYTES}-byte limit.`
  );

  const contextLines = requireNonNegativeSafeInteger(
    options.contextLines ?? 2,
    "contextLines"
  );
  const maxExcerptLines = requirePositiveSafeInteger(
    options.maxExcerptLines ?? 160,
    "maxExcerptLines"
  );
  const maxFailingTests = requirePositiveSafeInteger(
    options.maxFailingTests ?? 100,
    "maxFailingTests"
  );
  const maxRelevantErrorLines = requirePositiveSafeInteger(
    options.maxRelevantErrorLines ?? 100,
    "maxRelevantErrorLines"
  );
  const redactionsAlreadyApplied = requireNonNegativeSafeInteger(
    options.redactionsAlreadyApplied ?? 0,
    "redactionsAlreadyApplied"
  );

  const normalizedInput = rawLog.replace(/\r\n?/g, "\n");
  const redacted = redactSensitiveText(normalizedInput);
  const redaction = Object.freeze({
    applied:
      redactionsAlreadyApplied > 0 || redacted.redaction.applied,
    count: redactionsAlreadyApplied + redacted.redaction.count,
    disclosure: REDACTION_DISCLOSURE
  });
  const rawBytes = Buffer.byteLength(redacted.text, "utf8");
  const rawArtifact = Object.freeze({
    sha256: createHash("sha256")
      .update(redacted.text, "utf8")
      .digest("hex"),
    ...estimate(rawBytes)
  });
  const normalizedLog = redacted.text.replace(ANSI_ESCAPE_PATTERN, "");
  const lines = normalizedLog.length === 0 ? [] : normalizedLog.split("\n");

  const failures = collectEntries<FailingTestEntry>(
    lines,
    extractFailingTestName,
    (name, firstLine) => ({ name, firstLine, occurrences: 1 })
  );
  const errors = collectEntries<RelevantErrorEntry>(
    lines,
    (line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && RELEVANT_ERROR_PATTERN.test(trimmed)
        ? trimmed
        : null;
    },
    (text, firstLine) => ({ text, firstLine, occurrences: 1 })
  );

  const failingTests = Object.freeze(
    failures.entries
      .slice(0, maxFailingTests)
      .map((entry) => Object.freeze({ ...entry }))
  );
  const relevantErrorLines = Object.freeze(
    errors.entries
      .slice(0, maxRelevantErrorLines)
      .map((entry) => Object.freeze({ ...entry }))
  );
  const omittedFailingTests = failures.entries.length - failingTests.length;
  const omittedRelevantErrorLines =
    errors.entries.length - relevantErrorLines.length;
  const indexes = selectedLineIndexes(
    lines.length,
    [...failures.anchors, ...errors.anchors],
    contextLines,
    maxExcerptLines
  );
  const omittedOriginalLines = Math.max(0, lines.length - indexes.length);
  const truncated =
    omittedOriginalLines > 0 ||
    omittedFailingTests > 0 ||
    omittedRelevantErrorLines > 0;

  const output: string[] = [
    "TOKEN GOVERNOR TEST LOG EXTRACT",
    `Exit code: ${exitCode}`,
    `Raw artifact SHA-256: ${rawArtifact.sha256}`,
    `Raw bytes: ${rawArtifact.bytes}`,
    `Estimated raw tokens: ${rawArtifact.estimatedTokens} (UTF-8 bytes / 4, rounded up)`,
    `Original lines: ${lines.length}`,
    `Credential redactions: ${redaction.count}`,
    `Credential disclosure: ${redaction.disclosure}`,
    `Truncated: ${truncated ? "yes" : "no"}`,
    "",
    `Failing tests (${failingTests.length} retained):`
  ];
  if (failingTests.length === 0) {
    output.push("- none detected");
  } else {
    for (const entry of failingTests) {
      output.push(
        `- L${entry.firstLine}: ${entry.name}${
          entry.occurrences > 1 ? ` [x${entry.occurrences}]` : ""
        }`
      );
    }
  }
  if (omittedFailingTests > 0) {
    output.push(`- ${omittedFailingTests} additional names omitted`);
  }

  output.push(
    "",
    `Relevant error lines (${relevantErrorLines.length} retained):`
  );
  if (relevantErrorLines.length === 0) {
    output.push("- none detected");
  } else {
    for (const entry of relevantErrorLines) {
      output.push(
        `- L${entry.firstLine}: ${entry.text}${
          entry.occurrences > 1 ? ` [x${entry.occurrences}]` : ""
        }`
      );
    }
  }
  if (omittedRelevantErrorLines > 0) {
    output.push(
      `- ${omittedRelevantErrorLines} additional error lines omitted`
    );
  }

  output.push(
    "",
    `Selected excerpts (${indexes.length} of ${lines.length} lines):`,
    ...formatExcerpts(lines, indexes)
  );
  const text = `${output.join("\n")}\n`;
  const reducedArtifact = estimate(Buffer.byteLength(text, "utf8"));

  return Object.freeze({
    exitCode,
    text,
    failingTests,
    relevantErrorLines,
    rawArtifact,
    reducedArtifact,
    redaction,
    truncated,
    omittedOriginalLines,
    omittedFailingTests,
    omittedRelevantErrorLines
  });
}
