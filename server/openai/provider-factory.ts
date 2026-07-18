import type {
  GovernedResponseRequest,
  ResponseContext,
  TerminalResponse
} from "./index.js";
import { OpenAiResponsesClient } from "./index.js";
import type { ResponsesProvider } from "../runtime/index.js";

export type ProviderMode = "fake" | "hybrid" | "live";

const PROVIDER_MODES: readonly ProviderMode[] = ["fake", "hybrid", "live"];

export function resolveProviderMode(raw?: string): ProviderMode {
  if (raw === undefined || raw === "") {
    return "fake";
  }
  if ((PROVIDER_MODES as readonly string[]).includes(raw)) {
    return raw as ProviderMode;
  }
  throw new Error(
    `Unknown GOVERNOR_PROVIDER_MODE "${raw}"; expected one of ${PROVIDER_MODES.join(
      ", "
    )}.`
  );
}

export type CreateResponsesProviderOptions = {
  mode?: ProviderMode;
  apiKey?: string;
  scripted?: ResponsesProvider;
};

function requireApiKey(apiKey: string | undefined, mode: ProviderMode): string {
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error(
      `A non-empty OpenAI API key is required for "${mode}" mode; set OPENAI_API_KEY or pass options.apiKey.`
    );
  }
  return apiKey;
}

function requireScripted(
  scripted: ResponsesProvider | undefined,
  mode: ProviderMode
): ResponsesProvider {
  if (!scripted) {
    throw new Error(
      `A scripted provider is required for "${mode}" mode; pass options.scripted.`
    );
  }
  return scripted;
}

export function createResponsesProvider(
  options: CreateResponsesProviderOptions = {}
): ResponsesProvider {
  const mode =
    options.mode ?? resolveProviderMode(process.env.GOVERNOR_PROVIDER_MODE);
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

  if (mode === "live") {
    return new OpenAiResponsesClient({ apiKey: requireApiKey(apiKey, mode) });
  }

  if (mode === "hybrid") {
    const client = new OpenAiResponsesClient({
      apiKey: requireApiKey(apiKey, mode)
    });
    const scripted = requireScripted(options.scripted, mode);
    return {
      countInput(
        context: ResponseContext,
        signal?: AbortSignal
      ): Promise<number> {
        return client.countInput(context, signal);
      },
      createResponse(
        request: GovernedResponseRequest,
        signal?: AbortSignal
      ): Promise<TerminalResponse> {
        return scripted.createResponse(request, signal);
      }
    };
  }

  return requireScripted(options.scripted, mode);
}
