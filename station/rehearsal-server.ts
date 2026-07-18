import { createApp } from "../server/app.js";
import type {
  GovernedResponseRequest,
  TerminalResponse
} from "../server/openai/index.js";
import type { ResponsesProvider } from "../server/runtime/index.js";

// Runs the real jobs API (server/app.ts) with a scripted provider standing
// in for OpenAI, so the CLI/terminal demo can rehearse job create ->
// response create -> job show -> finalize end to end without a live
// OPENAI_API_KEY. Every dollar shown is still computed by the real
// reservation ledger and rate card; only the model call is faked. This is
// a fallback path if the live-key run isn't ready in time, never a
// replacement for it in the actual pitch.

const PORT = Number(process.env.PORT ?? "8790");
const HOST = process.env.HOST ?? "127.0.0.1";

function textOutput(text: string): TerminalResponse["output"] {
  return [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }]
    }
  ];
}

type RehearsalUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
};

// Both countInput and createResponse receive the same request.input, so
// keying the scripted profile off its content (rather than call order or
// shared mutable state) keeps the exact-input-token invariant true no
// matter how many jobs this process serves or in what order calls land.
const WORK_PROFILE: RehearsalUsage = {
  inputTokens: 6_200,
  outputTokens: 180,
  reasoningOutputTokens: 40
};
const FINAL_PROFILE: RehearsalUsage = {
  inputTokens: 2_100,
  outputTokens: 260,
  reasoningOutputTokens: 0
};

function profileFor(request: GovernedResponseRequest): RehearsalUsage {
  const text = typeof request.input === "string" ? request.input : "";
  return text.includes("structured review") ? FINAL_PROFILE : WORK_PROFILE;
}

function rehearsalProvider(): ResponsesProvider {
  return {
    async countInput(request: GovernedResponseRequest): Promise<number> {
      // Stands in for the exact preflight count the real
      // /v1/responses/input_tokens endpoint would return; must match the
      // inputTokens createResponse reports below for the same request.
      return profileFor(request).inputTokens;
    },

    async createResponse(
      request: GovernedResponseRequest
    ): Promise<TerminalResponse> {
      const profile = profileFor(request);
      const isFinal = profile === FINAL_PROFILE;
      return {
        id: isFinal ? "resp_rehearsal_final" : "resp_rehearsal_work",
        model: "gpt-5.4-mini",
        serviceTier: "default",
        status: "completed",
        output: textOutput(
          isFinal
            ? "FINDINGS: 1 critical - authorization check missing after " +
                "the retry path (auth.ts:142). No other seeded issues found."
            : "Investigated the diff and the failing test log. Found one " +
                "authorization-context regression; queued the structured review."
        ),
        usage: {
          inputTokens: profile.inputTokens,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: profile.outputTokens,
          reasoningOutputTokens: profile.reasoningOutputTokens,
          totalTokens: profile.inputTokens + profile.outputTokens
        }
      };
    }
  };
}

const app = createApp({ provider: rehearsalProvider() });
const server = app.listen(PORT, HOST, () => {
  console.log(
    `TokenGovernor rehearsal API (scripted provider, no OPENAI_API_KEY ` +
      `needed) listening on http://${HOST}:${PORT}`
  );
  console.log(
    `Point the CLI at it with --api http://${HOST}:${PORT}, or run ` +
      `station/run-demo.sh.`
  );
});
server.requestTimeout = 65_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
