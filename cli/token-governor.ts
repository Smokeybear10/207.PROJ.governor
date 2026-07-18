import { open as openFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_API_URL = "http://127.0.0.1:8787";
const DEMO_CONTROLLERS = new Set(["hard_cap", "static", "shadow"]);
const RESPONSE_PHASES = new Set(["work", "final"]);
const MAX_FUNCTION_CALL_SUMMARY_LENGTH = 500;
const MAX_RESPONSE_INPUT_BYTES = 256 * 1024;

type FetchImplementation = typeof globalThis.fetch;
type InputData = string | Uint8Array;
type InputReaderResult = InputData | Promise<InputData>;

export type CliOutput =
  | ((text: string) => unknown)
  | { write(text: string): unknown };

export interface CliDependencies {
  readonly fetch?: FetchImplementation;
  readonly stdout?: CliOutput;
  readonly stderr?: CliOutput;
  readonly readFile?: (path: string) => InputReaderResult;
  readonly readStdin?: () => InputReaderResult;
}

type HttpMethod = "GET" | "POST";

type ResponseInputSource =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "stdin" };

interface ParsedCommand {
  readonly name:
    | "health"
    | "demo"
    | "job-create"
    | "job-show"
    | "response-create"
    | "job-finalize";
  readonly method: HttpMethod;
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly json: boolean;
  readonly inputSource?: ResponseInputSource;
}

type FlagKind = "boolean" | "value";

interface ParsedFlags {
  readonly flags: ReadonlyMap<string, string | true>;
  readonly positionals: readonly string[];
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

function write(target: CliOutput, text: string): void {
  if (typeof target === "function") {
    target(text);
    return;
  }
  target.write(text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function terminalSafeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
      ""
    );
}

function terminalSafeLine(value: string): string {
  return terminalSafeText(value).replace(/[\n\t]+/g, " ").trim();
}

async function defaultReadFile(path: string): Promise<Uint8Array> {
  const handle = await openFile(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_RESPONSE_INPUT_BYTES + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytes,
        buffer.length - totalBytes,
        totalBytes
      );
      if (bytesRead === 0) {
        break;
      }
      totalBytes += bytesRead;
    }
    return buffer.subarray(0, totalBytes);
  } finally {
    await handle.close();
  }
}

async function defaultReadStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of process.stdin) {
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk as Uint8Array);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_RESPONSE_INPUT_BYTES) {
      throw new CliError("stdin input exceeds the 256 KiB limit");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, totalBytes);
}

function parseFlags(
  args: readonly string[],
  allowed: Readonly<Record<string, FlagKind>>
): ParsedFlags {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }

    if (!argument.startsWith("--") || argument === "--") {
      throw new CliError(`Unknown flag: ${argument}`);
    }

    const kind = allowed[argument];
    if (kind === undefined) {
      throw new CliError(`Unknown flag: ${argument}`);
    }
    if (flags.has(argument)) {
      throw new CliError(`Duplicate flag: ${argument}`);
    }

    if (kind === "boolean") {
      flags.set(argument, true);
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`Missing value for ${argument}`);
    }
    flags.set(argument, value);
    index += 1;
  }

  return { flags, positionals };
}

function requireFlag(
  flags: ReadonlyMap<string, string | true>,
  name: string
): string {
  const value = flags.get(name);
  if (typeof value !== "string") {
    throw new CliError(`Missing required flag: ${name}`);
  }
  if (value.length === 0) {
    throw new CliError(`${name} must not be empty`);
  }
  return value;
}

function optionalFlag(
  flags: ReadonlyMap<string, string | true>,
  name: string
): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function requireNoPositionals(
  positionals: readonly string[],
  command: string
): void {
  if (positionals.length > 0) {
    throw new CliError(
      `Unexpected argument for ${command}: ${positionals[0]}`
    );
  }
}

function parsePositiveInteger(value: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CliError(`${flag} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CliError(`${flag} must be a safe integer`);
  }
  return parsed;
}

function validateUsd(
  value: string,
  flag: string,
  allowZero: boolean
): string {
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(value)) {
    throw new CliError(
      `${flag} must be a decimal USD amount with at most 6 whole and 6 fractional digits`
    );
  }
  if (!allowZero && /^0(?:\.0+)?$/.test(value)) {
    throw new CliError(`${flag} must be greater than zero`);
  }
  return value;
}

function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`Invalid API URL: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError("API URL must use http or https");
  }
  if (url.username || url.password) {
    throw new CliError("API URL must not include credentials");
  }
  if (url.search || url.hash) {
    throw new CliError("API URL must not include a query or fragment");
  }

  return url.toString().replace(/\/+$/, "");
}

function extractApiFlag(args: readonly string[]): {
  readonly apiUrl: string;
  readonly commandArgs: readonly string[];
} {
  let apiValue: string | undefined;
  const commandArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument !== "--api") {
      commandArgs.push(argument);
      continue;
    }
    if (apiValue !== undefined) {
      throw new CliError("Duplicate flag: --api");
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError("Missing value for --api");
    }
    apiValue = value;
    index += 1;
  }

  return {
    apiUrl: normalizeApiUrl(apiValue ?? DEFAULT_API_URL),
    commandArgs
  };
}

function parseDemo(args: readonly string[]): ParsedCommand {
  const parsed = parseFlags(args, {
    "--scenario": "value",
    "--controller": "value",
    "--json": "boolean"
  });
  requireNoPositionals(parsed.positionals, "demo");

  const scenarioId = requireFlag(parsed.flags, "--scenario");
  const controller = requireFlag(parsed.flags, "--controller");
  if (!DEMO_CONTROLLERS.has(controller)) {
    throw new CliError(
      "--controller must be one of hard_cap, static, or shadow"
    );
  }

  return {
    name: "demo",
    method: "POST",
    path: "/api/demo/runs",
    body: { scenarioId, controller },
    json: parsed.flags.has("--json")
  };
}

function parseJobCreate(args: readonly string[]): ParsedCommand {
  const parsed = parseFlags(args, {
    "--budget": "value",
    "--final-reserve": "value",
    "--final-input-limit": "value",
    "--min-final-output": "value",
    "--max-responses": "value",
    "--json": "boolean"
  });
  requireNoPositionals(parsed.positionals, "job create");

  const body: Record<string, unknown> = {
    budget_usd: validateUsd(
      requireFlag(parsed.flags, "--budget"),
      "--budget",
      false
    )
  };

  const finalReserve = optionalFlag(parsed.flags, "--final-reserve");
  if (finalReserve !== undefined) {
    body.final_reserve_usd = validateUsd(
      finalReserve,
      "--final-reserve",
      true
    );
  }

  const finalInputLimit = optionalFlag(
    parsed.flags,
    "--final-input-limit"
  );
  if (finalInputLimit !== undefined) {
    body.final_input_token_limit = parsePositiveInteger(
      finalInputLimit,
      "--final-input-limit"
    );
  }

  const minimumFinalOutput = optionalFlag(
    parsed.flags,
    "--min-final-output"
  );
  if (minimumFinalOutput !== undefined) {
    body.minimum_final_output_tokens = parsePositiveInteger(
      minimumFinalOutput,
      "--min-final-output"
    );
  }

  const maxResponses = optionalFlag(parsed.flags, "--max-responses");
  if (maxResponses !== undefined) {
    body.max_responses = parsePositiveInteger(
      maxResponses,
      "--max-responses"
    );
  }

  return {
    name: "job-create",
    method: "POST",
    path: "/v1/jobs",
    body,
    json: parsed.flags.has("--json")
  };
}

function parseJobShow(args: readonly string[]): ParsedCommand {
  const parsed = parseFlags(args, { "--json": "boolean" });
  if (parsed.positionals.length !== 1) {
    throw new CliError("job show requires exactly one job ID");
  }
  const jobId = parsed.positionals[0]!;
  if (jobId.length === 0) {
    throw new CliError("Job ID must not be empty");
  }

  return {
    name: "job-show",
    method: "GET",
    path: `/v1/jobs/${encodeURIComponent(jobId)}`,
    json: parsed.flags.has("--json")
  };
}

function parseResponseCreate(args: readonly string[]): ParsedCommand {
  const parsed = parseFlags(args, {
    "--job": "value",
    "--request": "value",
    "--phase": "value",
    "--input": "value",
    "--input-file": "value",
    "--stdin": "boolean",
    "--instructions": "value",
    "--max-output": "value",
    "--min-output": "value",
    "--json": "boolean"
  });
  requireNoPositionals(parsed.positionals, "response create");

  const jobId = requireFlag(parsed.flags, "--job");
  const requestId = requireFlag(parsed.flags, "--request");
  const phase = requireFlag(parsed.flags, "--phase");
  if (!RESPONSE_PHASES.has(phase)) {
    throw new CliError("--phase must be either work or final");
  }

  const selectedInputSources = [
    parsed.flags.has("--input"),
    parsed.flags.has("--input-file"),
    parsed.flags.has("--stdin")
  ].filter(Boolean).length;
  if (selectedInputSources !== 1) {
    throw new CliError(
      "response create requires exactly one of --input, --input-file, or --stdin"
    );
  }

  const inputSource: ResponseInputSource = parsed.flags.has("--input")
    ? {
        kind: "text",
        value: requireFlag(parsed.flags, "--input")
      }
    : parsed.flags.has("--input-file")
      ? {
          kind: "file",
          path: requireFlag(parsed.flags, "--input-file")
        }
      : { kind: "stdin" };

  const body: Record<string, unknown> = {
    request_id: requestId,
    phase
  };

  const instructions = optionalFlag(parsed.flags, "--instructions");
  if (instructions !== undefined) {
    if (instructions.length === 0) {
      throw new CliError("--instructions must not be empty");
    }
    body.instructions = instructions;
  }

  const maximumOutput = optionalFlag(parsed.flags, "--max-output");
  if (maximumOutput !== undefined) {
    body.max_output_tokens = parsePositiveInteger(
      maximumOutput,
      "--max-output"
    );
  }

  const minimumOutput = optionalFlag(parsed.flags, "--min-output");
  if (minimumOutput !== undefined) {
    body.minimum_output_tokens = parsePositiveInteger(
      minimumOutput,
      "--min-output"
    );
  }

  if (
    typeof body.max_output_tokens === "number" &&
    typeof body.minimum_output_tokens === "number" &&
    body.minimum_output_tokens > body.max_output_tokens
  ) {
    throw new CliError("--min-output cannot exceed --max-output");
  }

  return {
    name: "response-create",
    method: "POST",
    path: `/v1/jobs/${encodeURIComponent(jobId)}/responses`,
    body,
    json: parsed.flags.has("--json"),
    inputSource
  };
}

function parseJobFinalize(args: readonly string[]): ParsedCommand {
  const parsed = parseFlags(args, {
    "--job": "value",
    "--request": "value",
    "--accept": "boolean",
    "--reject": "boolean",
    "--json": "boolean"
  });
  requireNoPositionals(parsed.positionals, "job finalize");

  const accepted = parsed.flags.has("--accept");
  const rejected = parsed.flags.has("--reject");
  if (accepted === rejected) {
    throw new CliError(
      "job finalize requires exactly one of --accept or --reject"
    );
  }

  const jobId = requireFlag(parsed.flags, "--job");
  const requestId = requireFlag(parsed.flags, "--request");
  return {
    name: "job-finalize",
    method: "POST",
    path: `/v1/jobs/${encodeURIComponent(jobId)}/finalize`,
    body: { request_id: requestId, accepted },
    json: parsed.flags.has("--json")
  };
}

function parseCommand(args: readonly string[]): {
  readonly apiUrl: string;
  readonly command: ParsedCommand;
} {
  const { apiUrl, commandArgs } = extractApiFlag(args);
  const commandName = commandArgs[0];
  if (commandName === undefined) {
    throw new CliError("Missing command");
  }

  if (commandName === "health") {
    if (commandArgs.length !== 1) {
      const extra = commandArgs[1]!;
      if (extra.startsWith("-")) {
        throw new CliError(`Unknown flag: ${extra}`);
      }
      throw new CliError(`Unexpected argument for health: ${extra}`);
    }
    return {
      apiUrl,
      command: {
        name: "health",
        method: "GET",
        path: "/api/health",
        json: false
      }
    };
  }

  if (commandName === "demo") {
    return { apiUrl, command: parseDemo(commandArgs.slice(1)) };
  }

  if (commandName === "job") {
    const subcommand = commandArgs[1];
    if (subcommand === "create") {
      return {
        apiUrl,
        command: parseJobCreate(commandArgs.slice(2))
      };
    }
    if (subcommand === "show") {
      return {
        apiUrl,
        command: parseJobShow(commandArgs.slice(2))
      };
    }
    if (subcommand === "finalize") {
      return {
        apiUrl,
        command: parseJobFinalize(commandArgs.slice(2))
      };
    }
    throw new CliError(
      subcommand === undefined
        ? "Missing job subcommand"
        : `Unknown job subcommand: ${subcommand}`
    );
  }

  if (commandName === "response") {
    const subcommand = commandArgs[1];
    if (subcommand === "create") {
      return {
        apiUrl,
        command: parseResponseCreate(commandArgs.slice(2))
      };
    }
    throw new CliError(
      subcommand === undefined
        ? "Missing response subcommand"
        : `Unknown response subcommand: ${subcommand}`
    );
  }

  if (commandName.startsWith("-")) {
    throw new CliError(`Unknown flag: ${commandName}`);
  }
  throw new CliError(`Unknown command: ${commandName}`);
}

function decodeInputData(value: InputData, label: string): string {
  const byteLength =
    typeof value === "string"
      ? Buffer.byteLength(value, "utf8")
      : value.byteLength;
  if (byteLength > MAX_RESPONSE_INPUT_BYTES) {
    throw new CliError(`${label} exceeds the 256 KiB limit`);
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new CliError(`${label} must contain valid UTF-8 text`);
  }
}

async function resolveResponseInput(
  command: ParsedCommand,
  dependencies: CliDependencies
): Promise<ParsedCommand> {
  const source = command.inputSource;
  if (command.name !== "response-create" || source === undefined) {
    return command;
  }

  let value: InputData;
  if (source.kind === "text") {
    value = source.value;
  } else {
    try {
      value =
        source.kind === "file"
          ? await (dependencies.readFile ?? defaultReadFile)(source.path)
          : await (dependencies.readStdin ?? defaultReadStdin)();
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }
      const origin =
        source.kind === "file"
          ? `input file ${source.path}`
          : "stdin";
      throw new CliError(
        `Unable to read ${origin}: ${errorMessage(error)}`
      );
    }
  }

  const label =
    source.kind === "text"
      ? "--input"
      : source.kind === "file"
        ? "--input-file"
        : "stdin input";
  return {
    ...command,
    body: {
      ...command.body,
      input: decodeInputData(value, label)
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiErrorMessage(status: number, payload: unknown): string {
  if (isRecord(payload) && isRecord(payload.error)) {
    const code =
      typeof payload.error.code === "string"
        ? payload.error.code
        : "API_ERROR";
    const message =
      typeof payload.error.message === "string"
        ? payload.error.message
        : "The API request failed.";
    return `HTTP ${status} ${code}: ${message}`;
  }
  return `HTTP ${status}: The API request failed without a JSON error envelope.`;
}

async function requestJson(
  fetchImpl: FetchImplementation,
  apiUrl: string,
  command: ParsedCommand
): Promise<unknown> {
  const url = `${apiUrl}${command.path}`;
  const init: RequestInit = { method: command.method };
  if (command.body !== undefined) {
    init.headers = {
      Accept: "application/json",
      "Content-Type": "application/json"
    };
    init.body = JSON.stringify(command.body);
  } else {
    init.headers = { Accept: "application/json" };
  }

  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new CliError(`Unable to reach ${url}: ${errorMessage(error)}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CliError(
      `HTTP ${response.status}: API response was not valid JSON`
    );
  }

  if (!response.ok) {
    throw new CliError(apiErrorMessage(response.status, payload));
  }
  return payload;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function asDisplayValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return terminalSafeLine(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function formatMicroUsd(value: unknown): string | undefined {
  if (
    (typeof value !== "number" || !Number.isSafeInteger(value)) &&
    (typeof value !== "string" || !/^-?\d+$/.test(value))
  ) {
    return undefined;
  }

  const micros = BigInt(value);
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const whole = absolute / 1_000_000n;
  const fraction = String(absolute % 1_000_000n).padStart(6, "0");
  return `${negative ? "-" : ""}$${whole}.${fraction}`;
}

function formatUsd(value: unknown, microUsd: boolean): string | undefined {
  if (microUsd) {
    return formatMicroUsd(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `$${value}`;
  }
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) {
    return `$${value}`;
  }
  return undefined;
}

function formatHealth(payload: unknown): string {
  if (!isRecord(payload)) {
    return JSON.stringify(payload, null, 2);
  }

  const lines: string[] = [];
  const service = asDisplayValue(payload.service);
  const status = asDisplayValue(payload.status);
  const mode = asDisplayValue(payload.mode);
  const providerConfigured = asDisplayValue(payload.providerConfigured);

  if (service !== undefined) {
    lines.push(`Service: ${service}`);
  }
  if (status !== undefined) {
    lines.push(`Status: ${status}`);
  }
  if (mode !== undefined) {
    lines.push(`Mode: ${mode}`);
  }
  if (providerConfigured !== undefined) {
    lines.push(`Provider configured: ${providerConfigured}`);
  }
  return lines.length > 0 ? lines.join("\n") : JSON.stringify(payload, null, 2);
}

function formatDemo(payload: unknown): string {
  const lines = ["DEMO: SYNTHETIC DATA"];
  const truthLabel = asDisplayValue(readPath(payload, ["truthLabel"]));
  if (truthLabel !== undefined) {
    lines.push(truthLabel);
  } else {
    lines.push("Synthetic simulation; not measured provider usage.");
  }

  const id = asDisplayValue(readPath(payload, ["id"]));
  const scenario =
    asDisplayValue(readPath(payload, ["scenario", "title"])) ??
    asDisplayValue(readPath(payload, ["scenarioId"]));
  const controller = asDisplayValue(readPath(payload, ["controller"]));
  const status =
    asDisplayValue(readPath(payload, ["finalSummary", "status"])) ??
    asDisplayValue(readPath(payload, ["status"]));
  const qualityStatus = asDisplayValue(
    readPath(payload, ["quality", "gate"])
  );

  if (id !== undefined) {
    lines.push(`Run: ${id}`);
  }
  if (scenario !== undefined) {
    lines.push(`Scenario: ${scenario}`);
  }
  if (controller !== undefined) {
    lines.push(`Controller: ${controller}`);
  }
  if (status !== undefined) {
    lines.push(`Run status: ${status}`);
  }
  if (qualityStatus !== undefined) {
    lines.push(`Quality status: ${qualityStatus}`);
  }

  const budget = formatMicroUsd(
    readPath(payload, ["taskPolicy", "applicationCeilingMicroUsd"])
  );
  const spend = formatMicroUsd(
    readPath(payload, ["finalSummary", "settledMicroUsd"])
  );
  const reserve = formatMicroUsd(
    readPath(payload, ["taskPolicy", "protectedFinalReserveMicroUsd"])
  );
  const remaining = formatMicroUsd(
    readPath(payload, ["finalSummary", "unusedMicroUsd"])
  );

  if (budget !== undefined) {
    lines.push(`Budget: ${budget}`);
  }
  if (spend !== undefined) {
    lines.push(`Spend: ${spend}`);
  }
  if (reserve !== undefined) {
    lines.push(`Reserve: ${reserve}`);
  }
  if (remaining !== undefined) {
    lines.push(`Remaining: ${remaining}`);
  }
  return lines.join("\n");
}

interface PrimitiveLeaf {
  readonly path: readonly string[];
  readonly value: string | number | boolean | null;
}

function primitiveLeaves(
  value: unknown,
  path: readonly string[] = [],
  depth = 0
): PrimitiveLeaf[] {
  if (depth > 6) {
    return [];
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return [{ path, value }];
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    primitiveLeaves(child, [...path, key], depth + 1)
  );
}

function normalizedKey(path: readonly string[]): string {
  return path.join("_").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function readablePath(path: readonly string[]): string {
  const text = path
    .join(" ")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  return text.length === 0
    ? "Value"
    : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

function moneyCategory(key: string): string | undefined {
  if (key.includes("reserve")) {
    return "Reserve";
  }
  if (
    key.includes("settled") ||
    key.includes("spend") ||
    key.includes("spent")
  ) {
    return "Spend";
  }
  if (key.includes("budget") || key.includes("applicationceiling")) {
    return "Budget";
  }
  if (
    key.includes("remaining") ||
    key.includes("uncommitted") ||
    key.includes("available")
  ) {
    return "Remaining";
  }
  return undefined;
}

function formatGeneric(
  payload: unknown,
  command: ParsedCommand["name"]
): string {
  const title =
    command === "response-create"
      ? "Response"
      : command === "job-finalize"
        ? "Finalized job"
        : "Job";
  const leaves = primitiveLeaves(payload);
  const lines = [title];

  const idLeaf = leaves.find((leaf) => {
    const key = normalizedKey(leaf.path);
    return key === "id" || key.endsWith("jobid") || key.endsWith("responseid");
  });
  if (idLeaf && idLeaf.value !== null) {
    lines.push(`ID: ${asDisplayValue(idLeaf.value)}`);
  }

  let statusCount = 0;
  for (const leaf of leaves) {
    const key = normalizedKey(leaf.path);
    const isStatus =
      key.endsWith("status") ||
      key.endsWith("admitted") ||
      key.endsWith("accepted") ||
      key.endsWith("closed");
    if (!isStatus || leaf.value === null) {
      continue;
    }
    const label =
      statusCount === 0 ? "Status" : readablePath(leaf.path);
    lines.push(`${label}: ${asDisplayValue(leaf.value)}`);
    statusCount += 1;
  }

  const categoryCounts = new Map<string, number>();
  for (const leaf of leaves) {
    const key = normalizedKey(leaf.path);
    if (!key.includes("usd")) {
      continue;
    }
    const category = moneyCategory(key);
    if (category === undefined) {
      continue;
    }
    const amount = formatUsd(leaf.value, key.includes("microusd"));
    if (amount === undefined) {
      continue;
    }
    const count = categoryCounts.get(category) ?? 0;
    const label =
      count === 0
        ? category
        : `${category} (${readablePath(leaf.path)})`;
    lines.push(`${label}: ${amount}`);
    categoryCounts.set(category, count + 1);
  }

  const outputLeaf = leaves.find((leaf) => {
    const key = normalizedKey(leaf.path);
    return key.endsWith("outputtext") || key.endsWith("output");
  });
  if (outputLeaf && typeof outputLeaf.value === "string") {
    lines.push(`Output: ${terminalSafeText(outputLeaf.value)}`);
  }

  if (lines.length === 1) {
    lines.push(terminalSafeText(JSON.stringify(payload, null, 2)));
  }
  return lines.join("\n");
}

function dollarValue(
  object: Record<string, unknown>,
  key: string
): string | undefined {
  return formatUsd(object[key], false);
}

function appendJobSummary(
  lines: string[],
  payload: unknown,
  includeTitle: boolean
): boolean {
  if (!isRecord(payload)) {
    return false;
  }

  if (includeTitle) {
    lines.push("Job");
  }

  const id = asDisplayValue(payload.id);
  const status = asDisplayValue(payload.status);
  if (id !== undefined) {
    lines.push(`ID: ${id}`);
  }
  if (status !== undefined) {
    lines.push(`Status: ${status}`);
  }

  if (isRecord(payload.policy)) {
    const budget = dollarValue(payload.policy, "budget_usd");
    const finalReserve = dollarValue(
      payload.policy,
      "final_reserve_usd"
    );
    if (budget !== undefined) {
      lines.push(`Budget: ${budget}`);
    }
    if (finalReserve !== undefined) {
      lines.push(`Final reserve: ${finalReserve}`);
    }
  }

  if (isRecord(payload.accounting)) {
    const spend = dollarValue(payload.accounting, "settled_usd");
    const reserve = dollarValue(payload.accounting, "reserved_usd");
    const committed = dollarValue(payload.accounting, "committed_usd");
    const remaining = dollarValue(
      payload.accounting,
      "uncommitted_usd"
    );
    const availableForWork = dollarValue(
      payload.accounting,
      "available_for_work_usd"
    );

    if (spend !== undefined) {
      lines.push(`Spend: ${spend}`);
    }
    if (reserve !== undefined) {
      lines.push(`Reserve: ${reserve}`);
    }
    if (committed !== undefined) {
      lines.push(`Committed: ${committed}`);
    }
    if (remaining !== undefined) {
      lines.push(`Remaining: ${remaining}`);
    }
    if (availableForWork !== undefined) {
      lines.push(`Available for work: ${availableForWork}`);
    }

    const responsesStarted = asDisplayValue(
      payload.accounting.responses_started
    );
    if (responsesStarted !== undefined) {
      lines.push(`Responses started: ${responsesStarted}`);
    }
  }

  const pendingRequest = asDisplayValue(
    payload.pending_final_validation_request_id
  );
  if (pendingRequest !== undefined) {
    lines.push(`Pending final validation: ${pendingRequest}`);
  } else if (payload.pending_final_validation_request_id === null) {
    lines.push("Pending final validation: none");
  }

  const completionAccepted = payload.completion_accepted;
  if (typeof completionAccepted === "boolean") {
    lines.push(`Completion accepted: ${completionAccepted}`);
  }
  return true;
}

function formatJob(payload: unknown): string {
  const lines: string[] = [];
  if (!appendJobSummary(lines, payload, true)) {
    return formatGeneric(payload, "job-show");
  }
  return lines.join("\n");
}

function boundedFunctionCallSummary(value: string): string {
  let summary = value.trim();
  try {
    const normalized = JSON.stringify(JSON.parse(summary));
    if (normalized !== undefined) {
      summary = normalized;
    }
  } catch {
    // Malformed arguments are still useful as a bounded opaque summary.
  }

  summary = terminalSafeText(summary);
  if (summary.length <= MAX_FUNCTION_CALL_SUMMARY_LENGTH) {
    return summary;
  }
  return `${summary.slice(0, MAX_FUNCTION_CALL_SUMMARY_LENGTH - 3)}...`;
}

function providerOutputLines(output: unknown): string[] {
  if (!Array.isArray(output)) {
    return [];
  }

  const textParts: string[] = [];
  const functionCalls: string[] = [];

  // Only these provider fields are safe for human output. Reasoning items,
  // including encrypted_content, deliberately have no display path.
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }

    if (
      item.type === "message" &&
      item.role === "assistant" &&
      Array.isArray(item.content)
    ) {
      for (const content of item.content) {
        if (
          isRecord(content) &&
          content.type === "output_text" &&
          typeof content.text === "string"
        ) {
          textParts.push(terminalSafeText(content.text));
        }
      }
      continue;
    }

    if (item.type === "function_call" && typeof item.name === "string") {
      const name = terminalSafeText(item.name)
        .replace(/\s+/g, " ")
        .trim();
      if (name.length === 0) {
        continue;
      }
      const argumentsSummary =
        typeof item.arguments === "string"
          ? boundedFunctionCallSummary(item.arguments)
          : "";
      functionCalls.push(
        `Function call: ${name}(${argumentsSummary})`
      );
    }
  }

  const lines: string[] = [];
  const assistantText = textParts.join("");
  if (assistantText.length > 0) {
    lines.push("Assistant output:", assistantText);
  }
  lines.push(...functionCalls);
  return lines;
}

function formatResponse(payload: unknown): string {
  const lines = ["Response"];
  if (!isRecord(payload) || !isRecord(payload.execution)) {
    lines.push("Execution status: unavailable");
    return lines.join("\n");
  }

  const executionStatus = asDisplayValue(payload.execution.status);
  const reason = asDisplayValue(payload.execution.reason);
  if (executionStatus !== undefined) {
    lines.push(`Execution status: ${executionStatus}`);
  }
  if (reason !== undefined) {
    lines.push(`Reason: ${reason}`);
  }

  if (isRecord(payload.execution.response)) {
    const responseId = asDisplayValue(payload.execution.response.id);
    const responseStatus = asDisplayValue(
      payload.execution.response.status
    );
    if (responseId !== undefined) {
      lines.push(`Provider response: ${responseId}`);
    }
    if (responseStatus !== undefined) {
      lines.push(`Provider status: ${responseStatus}`);
    }
    lines.push(...providerOutputLines(payload.execution.response.output));
  }

  if (isRecord(payload.execution.reservation)) {
    const requestId = asDisplayValue(
      payload.execution.reservation.request_id
    );
    const reservationStatus = asDisplayValue(
      payload.execution.reservation.status
    );
    if (requestId !== undefined) {
      lines.push(`Request: ${requestId}`);
    }
    if (reservationStatus !== undefined) {
      lines.push(`Reservation status: ${reservationStatus}`);
    }
  }

  if (isRecord(payload.job)) {
    lines.push("Job");
    appendJobSummary(lines, payload.job, false);
  }
  return lines.join("\n");
}

function formatHuman(payload: unknown, command: ParsedCommand): string {
  if (command.name === "health") {
    return formatHealth(payload);
  }
  if (command.name === "demo") {
    return formatDemo(payload);
  }
  if (command.name === "response-create") {
    return formatResponse(payload);
  }
  return formatJob(payload);
}

function successfulExitCode(
  command: ParsedCommand,
  payload: unknown
): 0 | 2 {
  if (
    command.name === "response-create" &&
    isRecord(payload) &&
    isRecord(payload.execution) &&
    (payload.execution.status === "unresolved" ||
      payload.execution.status === "provider_stopped")
  ) {
    return 2;
  }
  return 0;
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = {}
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;

  try {
    if (typeof fetchImpl !== "function") {
      throw new CliError("No fetch implementation is available");
    }

    const parsed = parseCommand(args);
    const command = await resolveResponseInput(
      parsed.command,
      dependencies
    );
    const { apiUrl } = parsed;
    const payload = await requestJson(fetchImpl, apiUrl, command);
    const output = command.json
      ? JSON.stringify(payload)
      : formatHuman(payload, command);
    if (output === undefined) {
      throw new CliError("API response could not be serialized as JSON");
    }
    write(stdout, `${output}\n`);
    return successfulExitCode(command, payload);
  } catch (error) {
    write(stderr, `Error: ${terminalSafeLine(errorMessage(error))}\n`);
    return 1;
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entrypoint)).href
) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
