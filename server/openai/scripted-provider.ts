import type {
  GovernedResponseRequest,
  ProviderUsage,
  ResponseContext,
  ResponseStatus,
  TerminalResponse
} from "./index.js";
import type { ResponsesProvider } from "../runtime/index.js";

export type ScriptedResponse = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly output: unknown[];
  readonly status?: ResponseStatus;
  readonly cachedInputTokens?: number;
  readonly reasoningOutputTokens?: number;
};

export class ScriptedResponsesProvider implements ResponsesProvider {
  readonly contexts: ResponseContext[] = [];
  readonly requests: GovernedResponseRequest[] = [];
  readonly #scripts: readonly ScriptedResponse[];
  #index = 0;
  #pending: ScriptedResponse | null = null;

  constructor(scripts: readonly ScriptedResponse[]) {
    this.#scripts = scripts;
  }

  async countInput(context: ResponseContext): Promise<number> {
    if (this.#pending !== null) {
      throw new Error("Script expected createResponse before another count.");
    }
    const script = this.#scripts[this.#index];
    if (!script) {
      throw new Error("Unexpected input-token preflight.");
    }
    this.contexts.push(structuredClone(context));
    this.#pending = script;
    return script.inputTokens;
  }

  async createResponse(
    request: GovernedResponseRequest
  ): Promise<TerminalResponse> {
    const script = this.#pending;
    if (!script) {
      throw new Error("Unexpected model response request.");
    }
    if (script.outputTokens > request.max_output_tokens) {
      throw new Error("Scripted output exceeds the governed output cap.");
    }

    this.requests.push(structuredClone(request));
    this.#pending = null;
    this.#index += 1;
    const cachedInputTokens = script.cachedInputTokens ?? 0;
    const usage: ProviderUsage = {
      inputTokens: script.inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens: 0,
      outputTokens: script.outputTokens,
      reasoningOutputTokens: script.reasoningOutputTokens ?? 0,
      totalTokens: script.inputTokens + script.outputTokens
    };
    return {
      id: `resp_script_${this.#index}`,
      model: request.model,
      serviceTier: "default",
      status: script.status ?? "completed",
      output: structuredClone(script.output),
      usage
    };
  }

  assertComplete(): void {
    if (this.#pending !== null || this.#index !== this.#scripts.length) {
      throw new Error(
        `Script consumed ${this.#index} of ${this.#scripts.length} responses.`
      );
    }
  }
}
