import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";

export { createApp } from "./app.js";
export * from "./artifacts/index.js";
export { ApiError, errorMessage } from "./errors.js";
export * from "./governor/index.js";
export {
  OpenAiApiError,
  OpenAiResponsesClient,
  ResponseOutputError,
  extractFinalText,
  parseWorkOutput,
  type GovernedResponseRequest,
  type JsonObject,
  type OpenAiResponsesClientOptions,
  type ProviderUsage as OpenAiProviderUsage,
  type ResponseContext,
  type ResponseStatus,
  type TerminalResponse,
  type ParsedFunctionCall,
  type ParsedWorkOutput
} from "./openai/index.js";
export * from "./runtime/index.js";
export * from "./review/index.js";
export { closeSse, formatSseEvent, openSse, sendSse } from "./sse.js";

export const app = createApp();

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";

if (entryPoint === import.meta.url) {
  const port = parsePort(process.env.PORT);
  const host = process.env.HOST ?? "127.0.0.1";
  const server = app.listen(port, host, () => {
    console.log(`TokenGovernor API listening on http://${host}:${port}`);
  });
  server.requestTimeout = 65_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
}
