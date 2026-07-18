import { describe, expect, it } from "vitest";
import {
  ResponseOutputError,
  extractFinalText,
  parseWorkOutput
} from "../server/openai/index.js";
import {
  MAX_ARGUMENT_BYTES,
  MAX_FINAL_EXPLANATION_BYTES,
  MAX_FINAL_FINDINGS,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_DEPTH,
  MAX_OUTPUT_NODES,
  parseFinalReviewOutput
} from "../server/openai/response-output.js";

const reasoning = {
  id: "rs_1",
  type: "reasoning",
  status: "completed",
  summary: [],
  encrypted_content: "opaque-reasoning"
};

const reasoningWithoutEncryptedContent = {
  id: "rs_1",
  type: "reasoning",
  status: "completed",
  summary: []
};

function call(overrides: Record<string, unknown> = {}) {
  return {
    id: "fc_1",
    type: "function_call",
    status: "completed",
    call_id: "call_1",
    name: "read_pr_diff",
    arguments: "{}",
    ...overrides
  };
}

function message(text = "Final review") {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text,
        annotations: []
      }
    ]
  };
}

function finalFinding(overrides: Record<string, unknown> = {}) {
  return {
    category: "correctness",
    severity: "P1",
    path: "src/retry.ts",
    start_line: 2,
    end_line: 2,
    explanation: "The retry boundary admits one extra attempt.",
    suggested_mitigation: "Use the configured retry limit.",
    ...overrides
  };
}

function captureResponseOutputError(run: () => unknown): ResponseOutputError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ResponseOutputError);
    expect(error).not.toBeInstanceOf(RangeError);
    return error as ResponseOutputError;
  }
  throw new Error("Expected a ResponseOutputError.");
}

describe("Responses output protocol", () => {
  it("preserves reasoning and parses one completed function call", () => {
    const output = [reasoning, call()];
    const parsed = parseWorkOutput(output);

    expect(parsed).toMatchObject({
      kind: "function_call",
      call: {
        id: "fc_1",
        callId: "call_1",
        name: "read_pr_diff",
        arguments: {}
      }
    });
    expect(parsed.replayItems).toEqual(output);
    expect(parsed.replayItems).not.toBe(output);
  });

  it("extracts ordered final text while allowing opaque reasoning", () => {
    expect(
      extractFinalText([
        reasoning,
        {
          ...message(),
          content: [
            { type: "output_text", text: "First", annotations: [] },
            { type: "output_text", text: " second", annotations: [] }
          ]
        }
      ])
    ).toBe("First second");
  });

  it("parses bounded structured findings and the explicit clean variant", () => {
    expect(
      parseFinalReviewOutput([
        message(
          JSON.stringify({
            status: "findings",
            findings: [finalFinding()]
          })
        )
      ])
    ).toMatchObject({
      review: {
        status: "findings",
        findings: [finalFinding()]
      }
    });
    expect(
      parseFinalReviewOutput([
        message(JSON.stringify({ status: "clean" }))
      ])
    ).toMatchObject({
      review: { status: "clean" }
    });
  });

  it.each([
    "not JSON",
    JSON.stringify({ status: "clean", findings: [] }),
    JSON.stringify({ status: "findings", findings: [] }),
    JSON.stringify({
      status: "findings",
      findings: [finalFinding({ start_line: 0 })]
    }),
    JSON.stringify({
      status: "findings",
      findings: [finalFinding({ start_line: 3, end_line: 2 })]
    }),
    JSON.stringify({
      status: "findings",
      findings: [
        finalFinding({
          explanation: "x".repeat(MAX_FINAL_EXPLANATION_BYTES + 1)
        })
      ]
    }),
    JSON.stringify({
      status: "findings",
      findings: Array.from(
        { length: MAX_FINAL_FINDINGS + 1 },
        () => finalFinding()
      )
    })
  ])("rejects malformed structured final review %#", (text) => {
    expect(() => parseFinalReviewOutput([message(text)])).toThrow(
      ResponseOutputError
    );
  });

  it.each([
    reasoningWithoutEncryptedContent,
    { ...reasoning, encrypted_content: "" },
    { ...reasoning, encrypted_content: "   " }
  ])("requires nonempty encrypted reasoning content %#", (item) => {
    expect(() => parseWorkOutput([item, call()])).toThrow(
      "Reasoning item requires encrypted_content"
    );
  });

  it.each([
    {
      label: "multiple calls",
      output: [call(), call({ id: "fc_2", call_id: "call_2" })]
    },
    {
      label: "mixed call and text",
      output: [call(), message()]
    },
    {
      label: "malformed arguments",
      output: [call({ arguments: "not-json" })]
    },
    {
      label: "non-object arguments",
      output: [call({ arguments: "[]" })]
    },
    {
      label: "unknown item",
      output: [{ id: "x", type: "web_search_call" }]
    },
    {
      label: "refusal",
      output: [
        {
          ...message(),
          content: [{ type: "refusal", refusal: "No." }]
        }
      ]
    }
  ])("rejects $label", ({ output }) => {
    expect(() => parseWorkOutput(output)).toThrow(ResponseOutputError);
  });

  it("rejects function calls and empty text in the final response", () => {
    expect(() => extractFinalText([call()])).toThrow(
      "final response cannot contain a function call"
    );
    expect(() => extractFinalText([message("   ")])).toThrow(
      "final response text is empty"
    );
  });

  it("rejects deeply nested output without recursive stack overflow", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 20_000; depth += 1) {
      nested = { nested };
    }

    const error = captureResponseOutputError(() =>
      parseWorkOutput([{ ...reasoning, summary: nested }, call()])
    );

    expect(error.message).toContain(
      `maximum structural depth of ${MAX_OUTPUT_DEPTH}`
    );
  });

  it("enforces the output structural node limit", () => {
    const error = captureResponseOutputError(() =>
      extractFinalText([
        {
          ...message(),
          metadata: Array.from(
            { length: MAX_OUTPUT_NODES },
            () => null
          )
        }
      ])
    );

    expect(error.message).toContain(
      `${MAX_OUTPUT_NODES}-node structural limit`
    );
  });

  it("enforces the output serialized-byte limit before cloning", () => {
    const error = captureResponseOutputError(() =>
      extractFinalText([message("x".repeat(MAX_OUTPUT_BYTES))])
    );

    expect(error.message).toContain(
      `${MAX_OUTPUT_BYTES}-byte serialized limit`
    );
  });

  it("validates deeply nested parsed function arguments iteratively", () => {
    const argumentDepth = 5_000;
    const rawArguments =
      `{"value":${"[".repeat(argumentDepth)}` +
      `0${"]".repeat(argumentDepth)}}`;
    expect(Buffer.byteLength(rawArguments, "utf8")).toBeLessThan(
      MAX_ARGUMENT_BYTES
    );

    const error = captureResponseOutputError(() =>
      parseWorkOutput([call({ arguments: rawArguments })])
    );

    expect(error.message).toContain(
      `maximum structural depth of ${MAX_OUTPUT_DEPTH}`
    );
  });

  it("enforces structural node limits on parsed function arguments", () => {
    const rawArguments = JSON.stringify({
      values: Array.from({ length: MAX_OUTPUT_NODES }, () => null)
    });
    expect(Buffer.byteLength(rawArguments, "utf8")).toBeLessThan(
      MAX_ARGUMENT_BYTES
    );

    const error = captureResponseOutputError(() =>
      parseWorkOutput([call({ arguments: rawArguments })])
    );

    expect(error.message).toContain(
      `${MAX_OUTPUT_NODES}-node structural limit`
    );
  });

  it("retains the 64 KiB raw function-argument limit", () => {
    const rawArguments = JSON.stringify({
      value: "x".repeat(MAX_ARGUMENT_BYTES)
    });

    const error = captureResponseOutputError(() =>
      parseWorkOutput([call({ arguments: rawArguments })])
    );

    expect(error.message).toBe("Function-call arguments are too large.");
  });
});
