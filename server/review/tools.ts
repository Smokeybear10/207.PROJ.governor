import { createHash } from "node:crypto";
import { z } from "zod";
import type { ArtifactStore } from "../artifacts/index.js";
import {
  MAX_TEST_LOG_BYTES,
  REDACTION_DISCLOSURE,
  redactSensitiveText,
  reduceTestLog,
  type RedactionMetadata
} from "../governor/log-reducer.js";
import type { JsonObject } from "../openai/index.js";

export const MAX_TOOL_RESULT_BYTES = 16 * 1024;
export const MAX_TOOL_ARGUMENT_BYTES = 8 * 1024;
export const MAX_FILE_RANGE_LINES = 200;
export const MAX_SNAPSHOT_FILE_COUNT = 1_000;
export const MAX_SNAPSHOT_PATH_BYTES = 1_024;
export const MAX_SNAPSHOT_DIFF_BYTES = 2 * 1024 * 1024;
export const MAX_SNAPSHOT_FILE_BYTES = 1 * 1024 * 1024;
export const MAX_SNAPSHOT_CI_LOG_BYTES = MAX_TEST_LOG_BYTES;
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export const PR_REVIEW_TOOL_NAMES = [
  "read_pr_diff",
  "read_file",
  "read_ci_log"
] as const;

export type PrReviewToolName = (typeof PR_REVIEW_TOOL_NAMES)[number];

export interface PrReviewSnapshot {
  readonly diff: string;
  readonly files: Readonly<Record<string, string>>;
  readonly ciLog: string;
  readonly ciExitCode: number;
}

export interface OpenAiFunctionToolDefinition extends JsonObject {
  readonly type: "function";
  readonly name: PrReviewToolName;
  readonly description: string;
  readonly strict: true;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export type PrReviewToolDispatcher = (
  name: string,
  argumentsValue: unknown
) => Promise<string>;

export interface ReviewToolbox {
  readonly definitions: readonly JsonObject[];
  execute(name: string, args: unknown): Promise<string>;
}

export type PrReviewToolErrorCode =
  | "UNKNOWN_TOOL"
  | "INVALID_ARGUMENTS"
  | "SNAPSHOT_LIMIT_EXCEEDED"
  | "FILE_NOT_FOUND"
  | "INVALID_RANGE"
  | "ARTIFACT_STORE_ERROR";

export class PrReviewToolError extends Error {
  readonly code: PrReviewToolErrorCode;

  constructor(
    code: PrReviewToolErrorCode,
    message: string,
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "PrReviewToolError";
    this.code = code;
  }
}

const emptyArgumentsSchema = z.object({}).strict();
const readFileArgumentsSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .refine(
        (value) => byteLength(value) <= MAX_SNAPSHOT_PATH_BYTES,
        {
          message: `path may include at most ${MAX_SNAPSHOT_PATH_BYTES} UTF-8 bytes.`
        }
      ),
    start_line: z.number().int().safe().positive(),
    end_line: z.number().int().safe().positive()
  })
  .strict()
  .refine((value) => value.start_line <= value.end_line, {
    message: "start_line must be less than or equal to end_line."
  })
  .refine(
    (value) =>
      value.end_line - value.start_line + 1 <= MAX_FILE_RANGE_LINES,
    {
      message: `A file read may include at most ${MAX_FILE_RANGE_LINES} lines.`
    }
  );

export const PR_REVIEW_TOOL_ARGUMENT_SCHEMAS = Object.freeze({
  read_pr_diff: emptyArgumentsSchema,
  read_file: readFileArgumentsSchema,
  read_ci_log: emptyArgumentsSchema
});

type ReadPrDiffArguments = z.infer<typeof emptyArgumentsSchema>;
type ReadFileArguments = z.infer<typeof readFileArgumentsSchema>;
type ReadCiLogArguments = z.infer<typeof emptyArgumentsSchema>;

export type ValidatedPrReviewToolArguments =
  | ReadPrDiffArguments
  | ReadFileArguments
  | ReadCiLogArguments;

export const PR_REVIEW_TOOL_DEFINITIONS: readonly OpenAiFunctionToolDefinition[] =
  deepFreeze([
    {
      type: "function",
      name: "read_pr_diff",
      description: "Read the complete pull-request diff from the fixed snapshot.",
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
      name: "read_file",
      description:
        "Read an inclusive, one-based line range from an allowlisted snapshot file.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Exact allowlisted repository-relative path."
          },
          start_line: {
            type: "integer",
            minimum: 1,
            description: "First line to return, inclusive."
          },
          end_line: {
            type: "integer",
            minimum: 1,
            description: "Last line to return, inclusive."
          }
        },
        required: ["path", "start_line", "end_line"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "read_ci_log",
      description:
        "Persist and read a deterministic reduction of the snapshot CI log.",
      strict: true,
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    }
  ] satisfies OpenAiFunctionToolDefinition[]);

// A shorter alias is useful at the Responses API request boundary.
export const PR_REVIEW_TOOLS = PR_REVIEW_TOOL_DEFINITIONS;

interface SanitizedSnapshotText {
  readonly text: string;
  readonly redaction: RedactionMetadata;
}

interface SanitizedSnapshotFile extends SanitizedSnapshotText {
  readonly displayPath: string;
}

interface ImmutableSnapshot {
  readonly diff: SanitizedSnapshotText;
  readonly files: ReadonlyMap<string, SanitizedSnapshotFile>;
  readonly ciLog: SanitizedSnapshotText;
  readonly ciExitCode: number;
}

interface ContentIdentity {
  readonly bytes: number;
  readonly sha256: string;
}

interface TruncationMetadata {
  readonly truncated: boolean;
  readonly maxBytes: number;
  readonly originalBytes: number;
  readonly returnedBytes: number;
  readonly omittedBytes: number;
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

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function contentIdentity(value: string): ContentIdentity {
  return {
    bytes: byteLength(value),
    sha256: sha256(value)
  };
}

function limitExceeded(message: string): never {
  throw new PrReviewToolError("SNAPSHOT_LIMIT_EXCEEDED", message);
}

function assertBoundedBytes(
  value: string,
  maxBytes: number,
  label: string
): number {
  const bytes = byteLength(value);
  if (bytes > maxBytes) {
    limitExceeded(`${label} exceeds the ${maxBytes}-byte limit.`);
  }
  return bytes;
}

function sanitizeSnapshotText(value: string): SanitizedSnapshotText {
  const redacted = redactSensitiveText(normalizeText(value));
  return Object.freeze({
    text: redacted.text,
    redaction: redacted.redaction
  });
}

function combineRedactions(
  ...redactions: readonly RedactionMetadata[]
): RedactionMetadata {
  const count = redactions.reduce(
    (total, redaction) => total + redaction.count,
    0
  );
  return Object.freeze({
    applied: count > 0,
    count,
    disclosure: REDACTION_DISCLOSURE
  });
}

function copySnapshotUnchecked(snapshot: PrReviewSnapshot): ImmutableSnapshot {
  if (typeof snapshot !== "object" || snapshot === null) {
    throw new PrReviewToolError(
      "INVALID_ARGUMENTS",
      "The PR review snapshot is invalid."
    );
  }

  const {
    diff,
    files: filesValue,
    ciLog,
    ciExitCode
  } = snapshot;
  if (
    typeof diff !== "string" ||
    typeof filesValue !== "object" ||
    filesValue === null ||
    Array.isArray(filesValue) ||
    typeof ciLog !== "string" ||
    !Number.isSafeInteger(ciExitCode)
  ) {
    throw new PrReviewToolError(
      "INVALID_ARGUMENTS",
      "The PR review snapshot is invalid."
    );
  }

  const validatedPaths: string[] = [];
  const validatedFiles: Array<readonly [string, string]> = [];
  let fileCount = 0;
  let totalBytes =
    assertBoundedBytes(
      diff,
      MAX_SNAPSHOT_DIFF_BYTES,
      "Snapshot diff"
    ) +
    assertBoundedBytes(
      ciLog,
      MAX_SNAPSHOT_CI_LOG_BYTES,
      "Snapshot CI log"
    );
  if (totalBytes > MAX_SNAPSHOT_BYTES) {
    limitExceeded(
      `Snapshot exceeds the ${MAX_SNAPSHOT_BYTES}-byte aggregate limit.`
    );
  }

  for (const path in filesValue) {
    if (!Object.prototype.hasOwnProperty.call(filesValue, path)) {
      continue;
    }
    fileCount += 1;
    if (fileCount > MAX_SNAPSHOT_FILE_COUNT) {
      limitExceeded(
        `Snapshot file count exceeds the ${MAX_SNAPSHOT_FILE_COUNT}-file limit.`
      );
    }
    totalBytes += assertBoundedBytes(
      path,
      MAX_SNAPSHOT_PATH_BYTES,
      "Snapshot path"
    );
    if (totalBytes > MAX_SNAPSHOT_BYTES) {
      limitExceeded(
        `Snapshot exceeds the ${MAX_SNAPSHOT_BYTES}-byte aggregate limit.`
      );
    }
    validatedPaths.push(path);
  }

  for (const path of validatedPaths) {
    const content = filesValue[path];
    if (typeof content !== "string") {
      throw new PrReviewToolError(
        "INVALID_ARGUMENTS",
        "Every snapshot file must contain text."
      );
    }
    totalBytes += assertBoundedBytes(
      content,
      MAX_SNAPSHOT_FILE_BYTES,
      "Snapshot file"
    );
    if (totalBytes > MAX_SNAPSHOT_BYTES) {
      limitExceeded(
        `Snapshot exceeds the ${MAX_SNAPSHOT_BYTES}-byte aggregate limit.`
      );
    }
    validatedFiles.push([path, content]);
  }

  const sanitizedDiff = sanitizeSnapshotText(diff);
  const sanitizedCiLog = sanitizeSnapshotText(ciLog);
  assertBoundedBytes(
    sanitizedDiff.text,
    MAX_SNAPSHOT_DIFF_BYTES,
    "Redacted snapshot diff"
  );
  assertBoundedBytes(
    sanitizedCiLog.text,
    MAX_SNAPSHOT_CI_LOG_BYTES,
    "Redacted snapshot CI log"
  );

  const files = new Map<string, SanitizedSnapshotFile>();
  for (const [path, content] of validatedFiles) {
    const sanitizedContent = sanitizeSnapshotText(content);
    const sanitizedPath = sanitizeSnapshotText(path);
    assertBoundedBytes(
      sanitizedContent.text,
      MAX_SNAPSHOT_FILE_BYTES,
      "Redacted snapshot file"
    );
    files.set(
      path,
      Object.freeze({
        text: sanitizedContent.text,
        displayPath: sanitizedPath.text,
        redaction: combineRedactions(
          sanitizedPath.redaction,
          sanitizedContent.redaction
        )
      })
    );
  }

  return Object.freeze({
    diff: sanitizedDiff,
    files,
    ciLog: sanitizedCiLog,
    ciExitCode
  });
}

function copySnapshot(snapshot: PrReviewSnapshot): ImmutableSnapshot {
  try {
    return copySnapshotUnchecked(snapshot);
  } catch (error) {
    if (error instanceof PrReviewToolError) {
      throw error;
    }
    throw new PrReviewToolError(
      "INVALID_ARGUMENTS",
      "The PR review snapshot could not be read.",
      { cause: error }
    );
  }
}

function parseJsonArguments(argumentsValue: unknown): unknown {
  if (typeof argumentsValue !== "string") {
    return argumentsValue;
  }
  if (byteLength(argumentsValue) > MAX_TOOL_ARGUMENT_BYTES) {
    throw new PrReviewToolError(
      "INVALID_ARGUMENTS",
      `Tool arguments exceed the ${MAX_TOOL_ARGUMENT_BYTES}-byte limit.`
    );
  }
  try {
    return JSON.parse(argumentsValue) as unknown;
  } catch (error) {
    throw new PrReviewToolError(
      "INVALID_ARGUMENTS",
      "Tool arguments must be valid JSON.",
      { cause: error }
    );
  }
}

function parseArguments<T>(
  schema: z.ZodType<T>,
  argumentsValue: unknown
): T {
  const parsed = schema.safeParse(parseJsonArguments(argumentsValue));
  if (!parsed.success) {
    throw new PrReviewToolError(
      "INVALID_ARGUMENTS",
      `Invalid tool arguments: ${z.prettifyError(parsed.error)}`,
      { cause: parsed.error }
    );
  }
  return parsed.data;
}

export function validatePrReviewToolCall(
  name: string,
  argumentsValue: unknown
): ValidatedPrReviewToolArguments {
  switch (name) {
    case "read_pr_diff":
      return parseArguments(
        PR_REVIEW_TOOL_ARGUMENT_SCHEMAS.read_pr_diff,
        argumentsValue
      );
    case "read_file":
      return parseArguments(
        PR_REVIEW_TOOL_ARGUMENT_SCHEMAS.read_file,
        argumentsValue
      );
    case "read_ci_log":
      return parseArguments(
        PR_REVIEW_TOOL_ARGUMENT_SCHEMAS.read_ci_log,
        argumentsValue
      );
    default:
      throw new PrReviewToolError(
        "UNKNOWN_TOOL",
        `Unknown PR review tool "${name}".`
      );
  }
}

function fileLines(content: string): readonly string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function truncationFor(
  originalBytes: number,
  returnedBytes: number
): TruncationMetadata {
  return {
    truncated: returnedBytes < originalBytes,
    maxBytes: MAX_TOOL_RESULT_BYTES,
    originalBytes,
    returnedBytes,
    omittedBytes: originalBytes - returnedBytes
  };
}

function resultObject(
  metadata: Readonly<Record<string, unknown>>,
  fullContent: ContentIdentity,
  returnedContent: string,
  returnedContentIdentity: ContentIdentity
): Readonly<Record<string, unknown>> {
  return {
    ...metadata,
    content: returnedContent,
    contentSha256: fullContent.sha256,
    returnedContentSha256: returnedContentIdentity.sha256,
    truncation: truncationFor(
      fullContent.bytes,
      returnedContentIdentity.bytes
    )
  };
}

function serializeCappedResult(
  metadata: Readonly<Record<string, unknown>>,
  content: string
): string {
  const fullContent = contentIdentity(content);
  const emptyIdentity = contentIdentity("");
  const emptyResult = JSON.stringify(
    resultObject(metadata, fullContent, "", emptyIdentity)
  );

  if (
    fullContent.bytes + byteLength(emptyResult) <=
    MAX_TOOL_RESULT_BYTES
  ) {
    const complete = JSON.stringify(
      resultObject(metadata, fullContent, content, fullContent)
    );
    if (byteLength(complete) <= MAX_TOOL_RESULT_BYTES) {
      return complete;
    }
  }

  const hashPlaceholder = "0".repeat(64);
  let low = 0;
  let high = Math.min(content.length, MAX_TOOL_RESULT_BYTES);
  let bestContent = "";

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const prefixEnd =
      middle > 0 &&
      middle < content.length &&
      /[\uD800-\uDBFF]/.test(content[middle - 1])
        ? middle - 1
        : middle;
    const prefix = content.slice(0, prefixEnd);
    const prefixBytes = byteLength(prefix);
    const candidate = JSON.stringify(
      resultObject(metadata, fullContent, prefix, {
        bytes: prefixBytes,
        sha256: hashPlaceholder
      })
    );
    if (byteLength(candidate) <= MAX_TOOL_RESULT_BYTES) {
      bestContent = prefix;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const best = JSON.stringify(
    resultObject(
      metadata,
      fullContent,
      bestContent,
      contentIdentity(bestContent)
    )
  );
  if (byteLength(best) <= MAX_TOOL_RESULT_BYTES) {
    return best;
  }

  const metadataJson = JSON.stringify(metadata);
  const fallback = JSON.stringify({
    tool: metadata.tool,
    redaction: metadata.redaction,
    content: "",
    contentSha256: fullContent.sha256,
    returnedContentSha256: emptyIdentity.sha256,
    metadataSha256: sha256(metadataJson),
    metadataTruncated: true,
    truncation: truncationFor(fullContent.bytes, 0)
  });
  if (byteLength(fallback) > MAX_TOOL_RESULT_BYTES) {
    throw new PrReviewToolError(
      "INVALID_ARGUMENTS",
      "Unable to serialize a bounded PR review tool result."
    );
  }
  return fallback;
}

function artifactReceiptMatches(
  value: unknown,
  expected: ContentIdentity
): value is {
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: "text/plain";
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "sha256" in value &&
    value.sha256 === expected.sha256 &&
    "bytes" in value &&
    value.bytes === expected.bytes &&
    "mediaType" in value &&
    value.mediaType === "text/plain"
  );
}

export class PrReviewToolbox {
  readonly #snapshot: ImmutableSnapshot;
  readonly #artifactStore: ArtifactStore;

  constructor(snapshot: PrReviewSnapshot, artifactStore: ArtifactStore) {
    if (
      typeof artifactStore !== "object" ||
      artifactStore === null ||
      typeof artifactStore.putText !== "function"
    ) {
      throw new PrReviewToolError(
        "INVALID_ARGUMENTS",
        "An ArtifactStore is required."
      );
    }
    this.#snapshot = copySnapshot(snapshot);
    this.#artifactStore = artifactStore;
  }

  async dispatch(name: string, argumentsValue: unknown): Promise<string> {
    const validatedArguments = validatePrReviewToolCall(
      name,
      argumentsValue
    );
    switch (name as PrReviewToolName) {
      case "read_pr_diff": {
        return serializeCappedResult(
          {
            tool: "read_pr_diff",
            redaction: this.#snapshot.diff.redaction
          },
          this.#snapshot.diff.text
        );
      }
      case "read_file": {
        return this.#readFile(validatedArguments as ReadFileArguments);
      }
      case "read_ci_log": {
        return this.#readCiLog();
      }
    }
  }

  async execute(name: string, args: unknown): Promise<string> {
    return this.dispatch(name, args);
  }

  #readFile(arguments_: ReadFileArguments): string {
    if (!this.#snapshot.files.has(arguments_.path)) {
      throw new PrReviewToolError(
        "FILE_NOT_FOUND",
        `Path "${arguments_.path}" is not in the snapshot allowlist.`
      );
    }

    const source = this.#snapshot.files.get(arguments_.path)!;
    const lines = fileLines(source.text);
    if (
      arguments_.start_line > lines.length ||
      arguments_.end_line > lines.length
    ) {
      throw new PrReviewToolError(
        "INVALID_RANGE",
        `Requested lines ${arguments_.start_line}-${arguments_.end_line} are outside the file's 1-${lines.length} range.`
      );
    }

    const content = lines
      .slice(arguments_.start_line - 1, arguments_.end_line)
      .join("\n");
    return serializeCappedResult(
      {
        tool: "read_file",
        path: source.displayPath,
        startLine: arguments_.start_line,
        endLine: arguments_.end_line,
        totalLines: lines.length,
        sourceSha256: sha256(source.text),
        redaction: source.redaction
      },
      content
    );
  }

  async #readCiLog(): Promise<string> {
    const expectedArtifact = contentIdentity(this.#snapshot.ciLog.text);
    let rawArtifact: {
      readonly sha256: string;
      readonly bytes: number;
      readonly mediaType: "text/plain";
    };
    try {
      const receipt = await this.#artifactStore.putText(
        this.#snapshot.ciLog.text
      );
      if (!artifactReceiptMatches(receipt, expectedArtifact)) {
        throw new PrReviewToolError(
          "ARTIFACT_STORE_ERROR",
          "The artifact store returned an invalid receipt."
        );
      }
      rawArtifact = Object.freeze({
        sha256: expectedArtifact.sha256,
        bytes: expectedArtifact.bytes,
        mediaType: "text/plain"
      });
    } catch (error) {
      if (error instanceof PrReviewToolError) {
        throw error;
      }
      throw new PrReviewToolError(
        "ARTIFACT_STORE_ERROR",
        "The redacted CI log could not be persisted.",
        { cause: error }
      );
    }

    const reduction = reduceTestLog(
      this.#snapshot.ciLog.text,
      this.#snapshot.ciExitCode,
      {
        redactionsAlreadyApplied:
          this.#snapshot.ciLog.redaction.count
      }
    );
    const reducedSha256 = sha256(reduction.text);

    return serializeCappedResult(
      {
        tool: "read_ci_log",
        exitCode: this.#snapshot.ciExitCode,
        rawArtifact: {
          sha256: rawArtifact.sha256,
          bytes: rawArtifact.bytes,
          mediaType: rawArtifact.mediaType
        },
        reducedArtifact: {
          sha256: reducedSha256,
          bytes: reduction.reducedArtifact.bytes,
          estimatedTokens: reduction.reducedArtifact.estimatedTokens
        },
        reduction: {
          truncated: reduction.truncated,
          failingTestCount: reduction.failingTests.length,
          relevantErrorLineCount: reduction.relevantErrorLines.length,
          omittedOriginalLines: reduction.omittedOriginalLines,
          omittedFailingTests: reduction.omittedFailingTests,
          omittedRelevantErrorLines: reduction.omittedRelevantErrorLines
        },
        redaction: reduction.redaction
      },
      reduction.text
    );
  }
}

export function createPrReviewToolDispatcher(
  snapshot: PrReviewSnapshot,
  artifactStore: ArtifactStore
): PrReviewToolDispatcher {
  const toolbox = new PrReviewToolbox(snapshot, artifactStore);
  return toolbox.dispatch.bind(toolbox);
}

export function createReviewToolbox(
  snapshot: PrReviewSnapshot,
  artifactStore: ArtifactStore
): ReviewToolbox {
  const toolbox = new PrReviewToolbox(snapshot, artifactStore);
  return Object.freeze({
    definitions: PR_REVIEW_TOOL_DEFINITIONS,
    execute: toolbox.execute.bind(toolbox)
  });
}
