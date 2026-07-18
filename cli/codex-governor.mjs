#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  defaultReminderThresholds,
  normalizePolicy,
  policyEnvironment
} from "../plugins/token-governor/scripts/policy.mjs";

const FEATURE_LINE = /^rollout_budget\s+under development\s+true\s*$/m;
const CONFLICTING_CONFIG = /(?:^|[.=])(?:features\.)?rollout_budget(?:[.=]|$)/;

export class CodexGovernorError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodexGovernorError";
  }
}

function requireValue(args, index, flag) {
  const value = args[index + 1];
  if (value === undefined || value === "--") {
    throw new CodexGovernorError(`Missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new CodexGovernorError(`${flag} must be a positive safe integer`);
  }
  return Number(value);
}

function parseWeight(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1_000) {
    throw new CodexGovernorError(`${flag} must be greater than 0 and at most 1000`);
  }
  return number;
}

function parseReminders(value) {
  const parts = value.split(",");
  if (parts.length === 0 || parts.some((part) => !/^[1-9]\d*$/.test(part))) {
    throw new CodexGovernorError(
      "--remind-at must be a comma-separated list of positive integers"
    );
  }
  return parts.map((part) => parsePositiveInteger(part, "--remind-at"));
}

function rejectConflictingCodexArguments(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--disable" && args[index + 1] === "rollout_budget") {
      throw new CodexGovernorError(
        "Codex arguments cannot disable the governed rollout budget"
      );
    }
    if (argument === "-c" || argument === "--config") {
      const value = args[index + 1] ?? "";
      if (CONFLICTING_CONFIG.test(value)) {
        throw new CodexGovernorError(
          "Codex arguments cannot override the governed rollout budget"
        );
      }
      index += 1;
      continue;
    }
    if (
      (argument.startsWith("-c=") || argument.startsWith("--config=")) &&
      CONFLICTING_CONFIG.test(argument)
    ) {
      throw new CodexGovernorError(
        "Codex arguments cannot override the governed rollout budget"
      );
    }
  }
}

export function parseCliArguments(argv) {
  const args = [...argv];
  const first = args[0];
  if (first === "--help" || first === "-h" || first === "help") {
    return { command: "help" };
  }
  if (first === "doctor") {
    let codexBinary = process.env.TOKEN_GOVERNOR_CODEX_BIN || "codex";
    for (let index = 1; index < args.length; index += 1) {
      if (args[index] === "--codex") {
        codexBinary = requireValue(args, index, "--codex");
        index += 1;
      } else {
        throw new CodexGovernorError(`Unknown doctor argument: ${args[index]}`);
      }
    }
    return { command: "doctor", codexBinary };
  }

  if (first === "codex") {
    args.shift();
  }

  let limitTokens;
  let inputWeight = 1;
  let outputWeight = 1;
  let reminders;
  let codexBinary = process.env.TOKEN_GOVERNOR_CODEX_BIN || "codex";
  let dryRun = false;
  let delimiterIndex = args.indexOf("--");
  if (delimiterIndex === -1) {
    delimiterIndex = args.length;
  }
  const governorArgs = args.slice(0, delimiterIndex);
  const codexArgs =
    delimiterIndex === args.length ? [] : args.slice(delimiterIndex + 1);

  for (let index = 0; index < governorArgs.length; index += 1) {
    const argument = governorArgs[index];
    if (argument === "--tokens") {
      limitTokens = parsePositiveInteger(
        requireValue(governorArgs, index, argument),
        argument
      );
      index += 1;
    } else if (argument === "--input-weight") {
      inputWeight = parseWeight(
        requireValue(governorArgs, index, argument),
        argument
      );
      index += 1;
    } else if (argument === "--output-weight") {
      outputWeight = parseWeight(
        requireValue(governorArgs, index, argument),
        argument
      );
      index += 1;
    } else if (argument === "--remind-at") {
      reminders = parseReminders(
        requireValue(governorArgs, index, argument)
      );
      index += 1;
    } else if (argument === "--codex") {
      codexBinary = requireValue(governorArgs, index, argument);
      index += 1;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      return { command: "help" };
    } else {
      throw new CodexGovernorError(
        `Unknown governor argument: ${argument}. Put Codex arguments after --`
      );
    }
  }

  if (limitTokens === undefined) {
    throw new CodexGovernorError("Missing required flag: --tokens");
  }
  const policy = normalizePolicy({
    limitTokens,
    inputWeight,
    outputWeight,
    reminders: reminders ?? defaultReminderThresholds(limitTokens)
  });
  rejectConflictingCodexArguments(codexArgs);
  return {
    command: "codex",
    codexBinary,
    codexArgs,
    dryRun,
    policy
  };
}

function tomlNumber(value) {
  if (!Number.isFinite(value)) {
    throw new CodexGovernorError("Token weights must be finite");
  }
  return String(value);
}

export function buildBudgetConfigArguments(value) {
  const policy = normalizePolicy(value);
  return [
    "-c",
    "features.rollout_budget.enabled=true",
    "-c",
    `features.rollout_budget.limit_tokens=${policy.limitTokens}`,
    "-c",
    `features.rollout_budget.reminder_at_remaining_tokens=[${policy.reminders.join(",")}]`,
    "-c",
    `features.rollout_budget.prefill_token_weight=${tomlNumber(policy.inputWeight)}`,
    "-c",
    `features.rollout_budget.sampling_token_weight=${tomlNumber(policy.outputWeight)}`
  ];
}

export function buildGovernedCodexArguments(policy, codexArgs) {
  rejectConflictingCodexArguments(codexArgs);
  return [...buildBudgetConfigArguments(policy), ...codexArgs];
}

function probeFailureMessage(result, codexBinary) {
  if (result.error) {
    return `Unable to run Codex at ${codexBinary}: ${result.error.message}`;
  }
  const detail = String(result.stderr || result.stdout || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  return detail
    ? `Codex rollout-budget preflight failed: ${detail}`
    : `Codex rollout-budget preflight exited with status ${result.status}`;
}

export function probeCodexRolloutBudget(
  codexBinary,
  policy,
  spawnSyncImpl = spawnSync,
  baseEnvironment = process.env
) {
  const environment = {
    ...baseEnvironment,
    ...policyEnvironment(policy)
  };
  const result = spawnSyncImpl(
    codexBinary,
    [...buildBudgetConfigArguments(policy), "features", "list"],
    {
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  if (result.error || result.status !== 0) {
    throw new CodexGovernorError(probeFailureMessage(result, codexBinary));
  }
  if (!FEATURE_LINE.test(String(result.stdout))) {
    throw new CodexGovernorError(
      "This Codex build did not confirm the native rollout-budget feature"
    );
  }
}

function spawnInherited(spawnImpl, binary, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(binary, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        resolve(128);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

export async function launchGovernedCodex(options, dependencies = {}) {
  const spawnSyncImpl = dependencies.spawnSync ?? spawnSync;
  const spawnImpl = dependencies.spawn ?? spawn;
  const baseEnvironment = dependencies.environment ?? process.env;
  probeCodexRolloutBudget(
    options.codexBinary,
    options.policy,
    spawnSyncImpl,
    baseEnvironment
  );

  const environment = {
    ...baseEnvironment,
    ...policyEnvironment(options.policy)
  };
  return spawnInherited(
    spawnImpl,
    options.codexBinary,
    buildGovernedCodexArguments(options.policy, options.codexArgs),
    {
      env: environment,
      stdio: "inherit"
    }
  );
}

function helpText() {
  return `Token Governor for Codex

Usage:
  token-governor codex --tokens <n> [options] -- [codex arguments]
  token-governor doctor [--codex <path>]

Options:
  --tokens <n>          Shared weighted-token cap for the Codex rollout
  --input-weight <n>    Weight for prefill/input tokens (default: 1)
  --output-weight <n>   Weight for sampling/output tokens (default: 1)
  --remind-at <a,b>     Remaining-token reminder thresholds
  --codex <path>        Codex executable (default: codex)
  --dry-run             Print the governed launch without starting Codex

Examples:
  token-governor codex --tokens 50000 --
  token-governor codex --tokens 50000 -- exec "Review this repository"
  token-governor codex --tokens 100000 --output-weight 6 --`;
}

function formatLaunch(parsed) {
  return [
    "Token Governor",
    `Cap: ${parsed.policy.limitTokens} weighted tokens`,
    `Weights: input x${parsed.policy.inputWeight}, output x${parsed.policy.outputWeight}`,
    `Reminders: ${parsed.policy.reminders.join(", ")} remaining`,
    "Prompt path: terminal -> Codex host (no Token Governor API proxy)"
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseCliArguments(argv);
    if (parsed.command === "help") {
      process.stdout.write(`${helpText()}\n`);
      return 0;
    }
    if (parsed.command === "doctor") {
      const policy = normalizePolicy({
        limitTokens: 1_000,
        inputWeight: 1,
        outputWeight: 1,
        reminders: [100]
      });
      probeCodexRolloutBudget(parsed.codexBinary, policy);
      process.stdout.write(
        "Token Governor ready: Codex accepted the native rollout-budget configuration.\n"
      );
      return 0;
    }

    process.stdout.write(`${formatLaunch(parsed)}\n`);
    if (parsed.dryRun) {
      process.stdout.write(
        `${JSON.stringify({
          executable: parsed.codexBinary,
          arguments: buildGovernedCodexArguments(
            parsed.policy,
            parsed.codexArgs
          )
        }, null, 2)}\n`
      );
      return 0;
    }
    return await launchGovernedCodex(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`token-governor: ${message}\n`);
    return 2;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
