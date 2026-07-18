import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildGovernedCodexArguments,
  launchGovernedCodex
} from "../cli/codex-governor.mjs";
import {
  policyEnvironment
} from "../plugins/token-governor/scripts/policy.mjs";
import {
  evaluatePromptGate
} from "../plugins/token-governor/scripts/prompt-gate.mjs";

const policy = {
  limitTokens: 50_000,
  inputWeight: 1,
  outputWeight: 6,
  reminders: [10_000, 5_000]
};

const promptHookInput = {
  cwd: "/workspace",
  hook_event_name: "UserPromptSubmit",
  model: "codex-model",
  permission_mode: "default",
  prompt: "Review this repository",
  session_id: "session-1",
  transcript_path: null,
  turn_id: "turn-1"
};

describe("Codex Token Governor extension", () => {
  it("blocks prompts that did not enter through the governed launcher", () => {
    expect(evaluatePromptGate(promptHookInput, {})).toMatchObject({
      continue: false,
      decision: "block"
    });
  });

  it("admits a governed prompt and injects the native shared cap", () => {
    expect(
      evaluatePromptGate(promptHookInput, policyEnvironment(policy))
    ).toMatchObject({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit"
      }
    });

    expect(buildGovernedCodexArguments(policy, ["exec", "Review"])).toEqual(
      expect.arrayContaining([
        "features.rollout_budget.enabled=true",
        "features.rollout_budget.limit_tokens=50000",
        "features.rollout_budget.reminder_at_remaining_tokens=[10000,5000]",
        "features.rollout_budget.prefill_token_weight=1",
        "features.rollout_budget.sampling_token_weight=6",
        "exec",
        "Review"
      ])
    );
  });

  it("does not start Codex when the host rejects budget configuration", async () => {
    const spawn = vi.fn();
    const spawnSync = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "rollout budget unsupported"
    }));

    await expect(
      launchGovernedCodex(
        {
          codexBinary: "codex",
          codexArgs: [],
          policy
        },
        {
          spawn,
          spawnSync,
          environment: {}
        }
      )
    ).rejects.toThrow("preflight failed");
    expect(spawn).not.toHaveBeenCalled();
  });
});
