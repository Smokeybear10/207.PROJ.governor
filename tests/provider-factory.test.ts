import { describe, expect, it } from "vitest";
import {
  createResponsesProvider,
  resolveProviderMode
} from "../server/openai/provider-factory.js";
import type { ResponsesProvider } from "../server/runtime/index.js";
import type {
  GovernedResponseRequest,
  TerminalResponse
} from "../server/openai/index.js";

function createStubProvider(): ResponsesProvider {
  return {
    async countInput(): Promise<number> {
      return 0;
    },
    async createResponse(
      request: GovernedResponseRequest
    ): Promise<TerminalResponse> {
      return {
        id: "resp_stub",
        model: request.model,
        serviceTier: "default",
        status: "completed",
        output: [],
        usage: null
      };
    }
  };
}

describe("resolveProviderMode", () => {
  it("accepts the three valid modes", () => {
    expect(resolveProviderMode("fake")).toBe("fake");
    expect(resolveProviderMode("hybrid")).toBe("hybrid");
    expect(resolveProviderMode("live")).toBe("live");
  });

  it("defaults to fake when unset", () => {
    expect(resolveProviderMode()).toBe("fake");
    expect(resolveProviderMode("")).toBe("fake");
  });

  it("rejects unknown modes", () => {
    expect(() => resolveProviderMode("bogus")).toThrow();
    expect(() => resolveProviderMode("LIVE")).toThrow();
  });
});

describe("createResponsesProvider", () => {
  it("returns the scripted provider in fake mode", () => {
    const scripted = createStubProvider();
    expect(createResponsesProvider({ mode: "fake", scripted })).toBe(scripted);
  });

  it("throws in fake mode without a scripted provider", () => {
    expect(() => createResponsesProvider({ mode: "fake" })).toThrow();
  });

  it("throws in live mode without an api key", () => {
    expect(() =>
      createResponsesProvider({ mode: "live", apiKey: "" })
    ).toThrow();
  });

  it("throws in hybrid mode without an api key", () => {
    const scripted = createStubProvider();
    expect(() =>
      createResponsesProvider({ mode: "hybrid", apiKey: "", scripted })
    ).toThrow();
  });

  it("throws in hybrid mode without a scripted provider", () => {
    expect(() =>
      createResponsesProvider({ mode: "hybrid", apiKey: "sk-test" })
    ).toThrow();
  });
});
