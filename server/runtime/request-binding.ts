import { createHash } from "node:crypto";
import {
  OpenAiApiError,
  type GovernedResponseRequest,
  type JsonObject,
  type ResponseContext
} from "../openai/index.js";

const CONTEXT_KEYS = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "previous_response_id",
  "service_tier"
]);

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

export type PreparedResponseContext = {
  readonly context: ResponseContext & { readonly service_tier: "default" };
  readonly canonicalJson: string;
  readonly sha256: string;
};

function canonicalize(
  value: unknown,
  path: string,
  seen: Set<object>
): CanonicalJson {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new OpenAiApiError(`${path} must contain finite JSON numbers.`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new OpenAiApiError(`${path} must contain JSON-compatible values.`);
  }
  if (seen.has(value)) {
    throw new OpenAiApiError(`${path} cannot contain a cycle.`);
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        canonicalize(item, `${path}[${index}]`, seen)
      );
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new OpenAiApiError(`${path} must contain plain JSON objects.`);
    }

    const result = Object.create(null) as Record<string, CanonicalJson>;
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        seen
      );
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function freezeJson<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    freezeJson(child);
  }
  return Object.freeze(value);
}

function digest(canonicalJson: string): string {
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}

function canonicalDocument(value: unknown, path: string): {
  value: CanonicalJson;
  json: string;
} {
  const normalized = canonicalize(value, path, new Set());
  return {
    value: freezeJson(normalized),
    json: JSON.stringify(normalized)
  };
}

export function prepareResponseContext(
  context: ResponseContext
): PreparedResponseContext {
  if (
    typeof context !== "object" ||
    context === null ||
    Array.isArray(context)
  ) {
    throw new OpenAiApiError("Response context must be an object.");
  }

  const ownKeys = Reflect.ownKeys(context);
  if (
    ownKeys.some(
      (key) => typeof key !== "string" || !CONTEXT_KEYS.has(key)
    )
  ) {
    throw new OpenAiApiError(
      "Response context contains an unsupported request option."
    );
  }
  if (
    typeof context.model !== "string" ||
    !context.model.trim() ||
    context.model !== context.model.trim()
  ) {
    throw new OpenAiApiError("A canonical model identifier is required.");
  }
  if (context.input === undefined) {
    throw new OpenAiApiError("Response input is required.");
  }
  if (
    context.instructions !== undefined &&
    typeof context.instructions !== "string"
  ) {
    throw new OpenAiApiError("Response instructions must be a string.");
  }
  if (context.previous_response_id !== undefined) {
    throw new OpenAiApiError(
      "The governed runtime does not permit previous_response_id."
    );
  }
  if (
    context.service_tier !== undefined &&
    context.service_tier !== "default"
  ) {
    throw new OpenAiApiError(
      "The governed runtime requires the default service tier."
    );
  }

  const candidate = {
    model: context.model,
    input: context.input,
    ...(context.instructions === undefined
      ? {}
      : { instructions: context.instructions }),
    ...(context.tools === undefined ? {} : { tools: context.tools }),
    service_tier: "default" as const
  };
  const document = canonicalDocument(candidate, "response context");
  const prepared = document.value as unknown as ResponseContext & {
    readonly service_tier: "default";
    readonly tools?: readonly JsonObject[];
  };

  return Object.freeze({
    context: prepared,
    canonicalJson: document.json,
    sha256: digest(document.json)
  });
}

export function fingerprintGovernedRequest(
  request: GovernedResponseRequest
): string {
  const document = canonicalDocument(request, "governed request");
  return digest(document.json);
}
