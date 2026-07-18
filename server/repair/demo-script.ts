import type { ScriptedResponse } from "../openai/scripted-provider.js";

/**
 * Deterministic scripted agent that repairs the `broken-sum` fixture: it runs
 * the tests, applies the one-line fix to `add`, re-runs to confirm green, then
 * summarizes. Used for the $0 `fake`-mode demo and the end-to-end test, so the
 * governed loop can be exercised without any live model call.
 */

function functionCall(
  callId: string,
  name: string,
  args: Record<string, unknown>
): unknown[] {
  return [
    {
      type: "function_call",
      id: `fc_${callId}`,
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
      status: "completed"
    }
  ];
}

function assistantText(text: string): unknown[] {
  return [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }]
    }
  ];
}

const ADD_OLD_TEXT = "export function add(a, b) {\n  return a - b;\n}";
const ADD_NEW_TEXT = "export function add(a, b) {\n  return a + b;\n}";

export function brokenSumRepairScripts(): ScriptedResponse[] {
  return [
    {
      inputTokens: 800,
      outputTokens: 24,
      output: functionCall("call_run_1", "run_tests", {})
    },
    {
      inputTokens: 1_100,
      outputTokens: 64,
      output: functionCall("call_patch_1", "apply_patch", {
        edits: [
          {
            path: "src/calculator.mjs",
            old_text: ADD_OLD_TEXT,
            new_text: ADD_NEW_TEXT
          }
        ]
      })
    },
    {
      inputTokens: 1_200,
      outputTokens: 24,
      output: functionCall("call_run_2", "run_tests", {})
    },
    {
      inputTokens: 1_300,
      outputTokens: 160,
      output: assistantText(
        "Root cause: `add(a, b)` in src/calculator.mjs used subtraction (`a - b`) instead of addition, so every add/sum assertion failed. Fix: changed the body to `return a + b;`. Re-running the pinned test command now passes all four tests."
      )
    }
  ];
}
