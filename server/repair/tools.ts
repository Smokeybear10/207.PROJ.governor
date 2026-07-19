import { z } from "zod";
import type { ArtifactStore } from "../artifacts/index.js";
import { reduceTestLog } from "../governor/log-reducer.js";
import type { JsonObject } from "../openai/index.js";
import {
  REPAIR_TOOL_NAMES,
  type RepairSandbox,
  type RepairToolName,
  type RepairToolbox,
  type SandboxEdit
} from "./types.js";

export const MAX_TOOL_RESULT_BYTES = 16 * 1024;
export const MAX_TOOL_ARGUMENT_BYTES = 8 * 1024;
export const MAX_FILE_RANGE_LINES = 200;
export const MAX_APPLY_PATCH_EDITS = 16;

export type RepairToolErrorCode = "UNKNOWN_TOOL" | "INVALID_ARGUMENTS";

export class RepairToolError extends Error {
  readonly code: RepairToolErrorCode;
  constructor(
    code: RepairToolErrorCode,
    message: string,
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "RepairToolError";
    this.code = code;
  }
}

interface RepairToolDefinition extends JsonObject {
  readonly type: "function";
  readonly name: RepairToolName;
  readonly description: string;
  readonly strict: true;
  readonly parameters: Readonly<Record<string, unknown>>;
}

const emptyArgumentsSchema = z.object({}).strict();

const readFileArgumentsSchema = z
  .object({
    path: z.string().min(1),
    start_line: z.number().int().safe().positive(),
    end_line: z.number().int().safe().positive()
  })
  .strict()
  .refine((value) => value.start_line <= value.end_line, {
    message: "start_line must be less than or equal to end_line."
  })
  .refine(
    (value) => value.end_line - value.start_line + 1 <= MAX_FILE_RANGE_LINES,
    { message: `A file read may include at most ${MAX_FILE_RANGE_LINES} lines.` }
  );

const applyPatchArgumentsSchema = z
  .object({
    edits: z
      .array(
        z
          .object({
            path: z.string().min(1),
            old_text: z.string().min(1),
            new_text: z.string()
          })
          .strict()
      )
      .min(1)
      .max(MAX_APPLY_PATCH_EDITS)
  })
  .strict();

type ReadFileArguments = z.infer<typeof readFileArgumentsSchema>;
type ApplyPatchArguments = z.infer<typeof applyPatchArgumentsSchema>;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export const REPAIR_TOOL_DEFINITIONS: readonly JsonObject[] = deepFreeze([
  {
    type: "function",
    name: "list_files",
    description:
      "List approved source files and read-only context/tests with their line and byte counts and edit permissions.",
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
      "Read an inclusive, one-based line range (at most 200 lines) from an approved source or read-only context/test file.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Allowlisted repository-relative path." },
        start_line: { type: "integer", minimum: 1, description: "First line, inclusive." },
        end_line: { type: "integer", minimum: 1, description: "Last line, inclusive." }
      },
      required: ["path", "start_line", "end_line"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "apply_patch",
    description:
      "Apply exact search/replace edits to allowlisted files. Each edit replaces one verbatim occurrence of old_text with new_text; all edits apply together or none do.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          minItems: 1,
          maxItems: MAX_APPLY_PATCH_EDITS,
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Allowlisted repository-relative path." },
              old_text: { type: "string", description: "Exact text to replace (must occur exactly once)." },
              new_text: { type: "string", description: "Replacement text." }
            },
            required: ["path", "old_text", "new_text"],
            additionalProperties: false
          }
        }
      },
      required: ["edits"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "run_tests",
    description:
      "Run the pinned test command against the current working tree and return the exit code with a reduced log.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  }
] satisfies RepairToolDefinition[]);

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function parseJsonArguments(argumentsValue: unknown): unknown {
  if (typeof argumentsValue !== "string") {
    return argumentsValue;
  }
  if (byteLength(argumentsValue) > MAX_TOOL_ARGUMENT_BYTES) {
    throw new RepairToolError(
      "INVALID_ARGUMENTS",
      `Tool arguments exceed the ${MAX_TOOL_ARGUMENT_BYTES}-byte limit.`
    );
  }
  try {
    return JSON.parse(argumentsValue) as unknown;
  } catch (error) {
    throw new RepairToolError(
      "INVALID_ARGUMENTS",
      "Tool arguments must be valid JSON.",
      { cause: error }
    );
  }
}

function parseArguments<T>(schema: z.ZodType<T>, argumentsValue: unknown): T {
  const parsed = schema.safeParse(parseJsonArguments(argumentsValue));
  if (!parsed.success) {
    throw new RepairToolError(
      "INVALID_ARGUMENTS",
      `Invalid tool arguments: ${z.prettifyError(parsed.error)}`,
      { cause: parsed.error }
    );
  }
  return parsed.data;
}

/**
 * Truncate the `content` field of a result object until the serialized JSON
 * fits the byte budget. Large content is spilled to the artifact store, so a
 * truncated view here is always recoverable by hash.
 */
function serializeCapped(
  result: Record<string, unknown>,
  contentKey: string
): string {
  const complete = JSON.stringify(result);
  if (byteLength(complete) <= MAX_TOOL_RESULT_BYTES) {
    return complete;
  }
  const content = result[contentKey];
  if (typeof content === "string") {
    const overhead = byteLength(
      JSON.stringify({ ...result, [contentKey]: "", truncated: true })
    );
    let budget = Math.max(0, MAX_TOOL_RESULT_BYTES - overhead);
    let sliced = content;
    while (byteLength(sliced) > budget && sliced.length > 0) {
      sliced = sliced.slice(0, Math.floor(sliced.length * 0.9) || 0);
    }
    const candidate = JSON.stringify({
      ...result,
      [contentKey]: sliced,
      truncated: true
    });
    if (byteLength(candidate) <= MAX_TOOL_RESULT_BYTES) {
      return candidate;
    }
  }
  return JSON.stringify({
    ...result,
    [contentKey]: "",
    truncated: true,
    note: "Result omitted to satisfy the tool result byte limit; retrieve by artifact hash."
  });
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

export function createRepairToolbox(
  sandbox: RepairSandbox,
  artifactStore: ArtifactStore
): RepairToolbox {
  if (typeof artifactStore?.putText !== "function") {
    throw new RepairToolError("INVALID_ARGUMENTS", "An ArtifactStore is required.");
  }

  function listFiles(): string {
    return JSON.stringify({
      tool: "list_files",
      revision: sandbox.revision(),
      files: sandbox.listFiles()
    });
  }

  function readFile(arguments_: ReadFileArguments): string {
    let source: string;
    try {
      source = sandbox.readFile(arguments_.path);
    } catch {
      return JSON.stringify({
        tool: "read_file",
        error: "FILE_NOT_ALLOWLISTED",
        path: arguments_.path
      });
    }
    const lines = fileLines(source);
    if (
      arguments_.start_line > lines.length ||
      arguments_.end_line > lines.length
    ) {
      return JSON.stringify({
        tool: "read_file",
        error: "INVALID_RANGE",
        path: arguments_.path,
        totalLines: lines.length
      });
    }
    const content = lines
      .slice(arguments_.start_line - 1, arguments_.end_line)
      .join("\n");
    return serializeCapped(
      {
        tool: "read_file",
        path: arguments_.path,
        startLine: arguments_.start_line,
        endLine: arguments_.end_line,
        totalLines: lines.length,
        content,
        truncated: false
      },
      "content"
    );
  }

  function applyPatch(arguments_: ApplyPatchArguments): string {
    const edits: SandboxEdit[] = arguments_.edits.map((edit) => ({
      path: edit.path,
      oldText: edit.old_text,
      newText: edit.new_text
    }));
    const result = sandbox.applyEdits(edits);
    return JSON.stringify({
      tool: "apply_patch",
      applied: result.applied,
      revision: result.revision,
      changedPaths: result.changedPaths,
      rejected: result.rejected
    });
  }

  async function runTests(signal?: AbortSignal): Promise<string> {
    const run = await sandbox.runTests(signal);
    const reduced = reduceTestLog(run.stdout, run.exitCode);
    const artifact = await artifactStore.putText(reduced.text);
    return serializeCapped(
      {
        tool: "run_tests",
        exitCode: run.exitCode,
        passed: run.exitCode === 0,
        revision: sandbox.revision(),
        durationMs: run.durationMs,
        failingTests: reduced.failingTests,
        reducedLog: reduced.text,
        truncated: reduced.truncated,
        artifact: { sha256: artifact.sha256, bytes: artifact.bytes }
      },
      "reducedLog"
    );
  }

  async function execute(
    name: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<string> {
    signal?.throwIfAborted();
    switch (name as RepairToolName) {
      case "list_files":
        parseArguments(emptyArgumentsSchema, args);
        return listFiles();
      case "read_file":
        return readFile(parseArguments(readFileArgumentsSchema, args));
      case "apply_patch":
        return applyPatch(parseArguments(applyPatchArgumentsSchema, args));
      case "run_tests":
        parseArguments(emptyArgumentsSchema, args);
        return runTests(signal);
      default:
        throw new RepairToolError(
          "UNKNOWN_TOOL",
          `Unknown repair tool "${String(name)}".`
        );
    }
  }

  if (REPAIR_TOOL_NAMES.length !== 4) {
    throw new RepairToolError("INVALID_ARGUMENTS", "Repair tool registry drift.");
  }

  return Object.freeze({
    definitions: REPAIR_TOOL_DEFINITIONS,
    execute,
    revision: () => sandbox.revision()
  });
}
