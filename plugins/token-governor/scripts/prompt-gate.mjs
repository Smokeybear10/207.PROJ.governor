#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { policyFromEnvironment } from "./policy.mjs";

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;

function block(reason) {
  return {
    continue: false,
    decision: "block",
    reason,
    stopReason: reason,
    systemMessage: reason
  };
}

function validHookInput(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.hook_event_name === "UserPromptSubmit" &&
    typeof value.cwd === "string" &&
    typeof value.model === "string" &&
    typeof value.prompt === "string" &&
    typeof value.session_id === "string" &&
    typeof value.turn_id === "string"
  );
}

export function evaluatePromptGate(input, environment = process.env) {
  if (!validHookInput(input)) {
    return block("Token Governor blocked this prompt because the hook payload was invalid.");
  }

  let policy;
  try {
    policy = policyFromEnvironment(environment);
  } catch {
    return block(
      "Token Governor blocked this prompt. Start Codex with `token-governor codex --tokens <n> -- ...`."
    );
  }

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        `Token Governor is active. The host session has a shared ` +
        `${policy.limitTokens}-weighted-token rollout cap ` +
        `(input x${policy.inputWeight}, output x${policy.outputWeight}).`
    }
  };
}

async function readHookInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_HOOK_INPUT_BYTES) {
      throw new Error("hook input is too large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

async function main() {
  try {
    const input = await readHookInput();
    process.stdout.write(`${JSON.stringify(evaluatePromptGate(input))}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify(block(
      "Token Governor blocked this prompt because its admission hook failed."
    ))}\n`);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
