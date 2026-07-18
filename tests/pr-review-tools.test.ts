import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryArtifactStore,
  type ArtifactStore
} from "../server/artifacts/index.js";
import {
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_CI_LOG_BYTES,
  MAX_SNAPSHOT_DIFF_BYTES,
  MAX_SNAPSHOT_FILE_BYTES,
  MAX_SNAPSHOT_FILE_COUNT,
  MAX_SNAPSHOT_PATH_BYTES,
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_RESULT_BYTES,
  MAX_FILE_RANGE_LINES,
  PR_REVIEW_TOOL_DEFINITIONS,
  PrReviewToolError,
  createReviewToolbox,
  createPrReviewToolDispatcher,
  validatePrReviewToolCall,
  type PrReviewSnapshot
} from "../server/review/tools.js";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function snapshot(
  overrides: Partial<PrReviewSnapshot> = {}
): PrReviewSnapshot {
  return {
    diff: "diff --git a/src/a.ts b/src/a.ts\r\n+const value = 1;\r\n",
    files: {
      "src/a.ts": "first\r\nsecond\r\nthird\r\n"
    },
    ciLog:
      "RUN tests\r\nFAIL retry context\r\nAssertionError: expected true\r\n",
    ciExitCode: 1,
    ...overrides
  };
}

function result(value: string): Record<string, any> {
  return JSON.parse(value) as Record<string, any>;
}

describe("PR review tools", () => {
  it("exports exactly three strict OpenAI function definitions", () => {
    expect(PR_REVIEW_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual([
      "read_pr_diff",
      "read_file",
      "read_ci_log"
    ]);
    for (const definition of PR_REVIEW_TOOL_DEFINITIONS) {
      expect(definition.type).toBe("function");
      expect(definition.strict).toBe(true);
      expect(definition.parameters.additionalProperties).toBe(false);
    }
  });

  it("exposes the workflow-facing toolbox interface", async () => {
    const toolbox = createReviewToolbox(
      snapshot(),
      new MemoryArtifactStore()
    );

    expect(toolbox.definitions).toBe(PR_REVIEW_TOOL_DEFINITIONS);
    await expect(toolbox.execute("read_pr_diff", {})).resolves.toBe(
      await createPrReviewToolDispatcher(
        snapshot(),
        new MemoryArtifactStore()
      )("read_pr_diff", {})
    );
  });

  it("is deterministic over a normalized deep copy of the snapshot", async () => {
    const mutable = {
      diff: "old\r\ndiff\r\n",
      files: { "src/a.ts": "one\r\ntwo\r\n" },
      ciLog: "PASS\r\n",
      ciExitCode: 0
    };
    const dispatch = createPrReviewToolDispatcher(
      mutable,
      new MemoryArtifactStore()
    );

    mutable.diff = "new diff";
    mutable.files["src/a.ts"] = "changed";
    mutable.ciLog = "FAIL changed";

    const firstDiff = await dispatch("read_pr_diff", {});
    const secondDiff = await dispatch("read_pr_diff", "{}");
    const file = result(
      await dispatch("read_file", {
        path: "src/a.ts",
        start_line: 1,
        end_line: 2
      })
    );

    expect(firstDiff).toBe(secondDiff);
    expect(result(firstDiff)).toMatchObject({
      content: "old\ndiff\n",
      contentSha256: digest("old\ndiff\n"),
      truncation: {
        truncated: false,
        originalBytes: 9,
        returnedBytes: 9,
        omittedBytes: 0
      }
    });
    expect(file.content).toBe("one\ntwo");
    expect(file.totalLines).toBe(2);
  });

  it("persists the normalized raw CI log and returns its reduction", async () => {
    const memoryStore = new MemoryArtifactStore();
    const putText = vi.fn((content: string) => memoryStore.putText(content));
    const artifactStore: ArtifactStore = {
      putText,
      readText: (sha256) => memoryStore.readText(sha256)
    };
    const dispatch = createPrReviewToolDispatcher(snapshot(), artifactStore);

    const serialized = await dispatch("read_ci_log", {});
    const parsed = result(serialized);

    expect(putText).toHaveBeenCalledOnce();
    expect(putText).toHaveBeenCalledWith(
      "RUN tests\nFAIL retry context\nAssertionError: expected true\n"
    );
    await expect(
      memoryStore.readText(parsed.rawArtifact.sha256)
    ).resolves.toBe(
      "RUN tests\nFAIL retry context\nAssertionError: expected true\n"
    );
    expect(parsed.content).toContain("TOKEN GOVERNOR TEST LOG EXTRACT");
    expect(parsed.content).toContain("retry context");
    expect(parsed.content).toContain("AssertionError: expected true");
    expect(parsed.rawArtifact.sha256).toBe(
      digest("RUN tests\nFAIL retry context\nAssertionError: expected true\n")
    );
    expect(parsed.reducedArtifact.sha256).toBe(digest(parsed.content));
  });

  it("rejects traversal, unknown fields, and invalid ranges", async () => {
    const dispatch = createPrReviewToolDispatcher(
      snapshot(),
      new MemoryArtifactStore()
    );

    await expect(
      dispatch("read_file", {
        path: "../src/a.ts",
        start_line: 1,
        end_line: 1
      })
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    await expect(
      dispatch("read_pr_diff", { unexpected: true })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    await expect(
      dispatch("read_file", {
        path: "src/a.ts",
        start_line: 1,
        end_line: 1,
        unexpected: true
      })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    await expect(
      dispatch("read_file", {
        path: "src/a.ts",
        start_line: 0,
        end_line: 1
      })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    await expect(
      dispatch("read_file", {
        path: "src/a.ts",
        start_line: 2,
        end_line: 1
      })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    await expect(
      dispatch("read_file", {
        path: "src/a.ts",
        start_line: 1,
        end_line: 4
      })
    ).rejects.toMatchObject({ code: "INVALID_RANGE" });
    await expect(
      dispatch("read_file", {
        path: "src/a.ts",
        start_line: 1,
        end_line: MAX_FILE_RANGE_LINES + 1
      })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
  });

  it("rejects unknown tools without invoking the artifact store", async () => {
    const artifactStore: ArtifactStore = {
      putText: vi.fn(),
      readText: vi.fn()
    };
    const dispatch = createPrReviewToolDispatcher(snapshot(), artifactStore);

    await expect(dispatch("run_shell", {})).rejects.toBeInstanceOf(
      PrReviewToolError
    );
    await expect(dispatch("run_shell", {})).rejects.toMatchObject({
      code: "UNKNOWN_TOOL"
    });
    expect(artifactStore.putText).not.toHaveBeenCalled();
  });

  it("validates exact tool names and returns parsed strict arguments", () => {
    expect(
      validatePrReviewToolCall(
        "read_file",
        JSON.stringify({
          path: "src/a.ts",
          start_line: 1,
          end_line: 2
        })
      )
    ).toEqual({
      path: "src/a.ts",
      start_line: 1,
      end_line: 2
    });
    expect(() =>
      validatePrReviewToolCall("READ_FILE", {})
    ).toThrowError(
      expect.objectContaining({ code: "UNKNOWN_TOOL" })
    );
    expect(() =>
      validatePrReviewToolCall("read_File", {})
    ).toThrowError(
      expect.objectContaining({ code: "UNKNOWN_TOOL" })
    );
    expect(() =>
      validatePrReviewToolCall("read_pr_diff", { extra: true })
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENTS" })
    );
    expect(() =>
      validatePrReviewToolCall(
        "read_file",
        {
          path: "p".repeat(MAX_SNAPSHOT_PATH_BYTES + 1),
          start_line: 1,
          end_line: 1
        }
      )
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENTS" })
    );
    expect(() =>
      validatePrReviewToolCall(
        "read_pr_diff",
        " ".repeat(MAX_TOOL_ARGUMENT_BYTES + 1)
      )
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENTS" })
    );
  });

  it("rejects every snapshot byte budget before processing", () => {
    const oversizedCases: PrReviewSnapshot[] = [
      snapshot({
        diff: "d".repeat(MAX_SNAPSHOT_DIFF_BYTES + 1)
      }),
      snapshot({
        files: {
          ["p".repeat(MAX_SNAPSHOT_PATH_BYTES + 1)]: ""
        }
      }),
      snapshot({
        files: {
          "large.txt": "f".repeat(MAX_SNAPSHOT_FILE_BYTES + 1)
        }
      }),
      snapshot({
        ciLog: "c".repeat(MAX_SNAPSHOT_CI_LOG_BYTES + 1)
      }),
      snapshot({
        diff: "d".repeat(MAX_SNAPSHOT_DIFF_BYTES),
        ciLog: "c".repeat(MAX_SNAPSHOT_CI_LOG_BYTES),
        files: {
          a: "a".repeat(MAX_SNAPSHOT_FILE_BYTES),
          b: "b".repeat(MAX_SNAPSHOT_FILE_BYTES)
        }
      })
    ];

    for (const oversized of oversizedCases) {
      expect(() =>
        createPrReviewToolDispatcher(
          oversized,
          new MemoryArtifactStore()
        )
      ).toThrowError(
        expect.objectContaining({
          code: "SNAPSHOT_LIMIT_EXCEEDED"
        })
      );
    }

    expect(MAX_SNAPSHOT_BYTES).toBeLessThan(
      MAX_SNAPSHOT_DIFF_BYTES +
        MAX_SNAPSHOT_CI_LOG_BYTES +
        3 * MAX_SNAPSHOT_FILE_BYTES
    );
  });

  it("checks file count before reading snapshot file values", () => {
    let fileValueRead = false;
    const files: Record<string, string> = {};
    Object.defineProperty(files, "guarded.txt", {
      enumerable: true,
      get() {
        fileValueRead = true;
        return "must not be read";
      }
    });
    for (let index = 0; index < MAX_SNAPSHOT_FILE_COUNT; index += 1) {
      files[`file-${index}.txt`] = "";
    }

    expect(() =>
      createPrReviewToolDispatcher(
        snapshot({ files }),
        new MemoryArtifactStore()
      )
    ).toThrowError(
      expect.objectContaining({ code: "SNAPSHOT_LIMIT_EXCEEDED" })
    );
    expect(fileValueRead).toBe(false);
  });

  it("redacts credentials from all outputs and the persisted CI log", async () => {
    const secrets = [
      "bearer-diff-secret",
      "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
      "diff-private-key-value",
      "file-token-secret",
      "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD",
      "AKIAIOSFODNN7EXAMPLE",
      "dXNlcjpwYXNzd29yZA==",
      "ci-password-secret"
    ];
    const memoryStore = new MemoryArtifactStore();
    const putText = vi.fn((content: string) =>
      memoryStore.putText(content)
    );
    const dispatch = createPrReviewToolDispatcher(
      snapshot({
        diff: [
          `Authorization: Bearer ${secrets[0]}`,
          secrets[1],
          "-----BEGIN PRIVATE KEY-----",
          secrets[2],
          "-----END PRIVATE KEY-----"
        ].join("\n"),
        files: {
          [`secrets-${secrets[4]}.txt`]: [
            `SERVICE_TOKEN=${secrets[3]}`,
            secrets[4],
            secrets[5]
          ].join("\n")
        },
        ciLog: [
          `Authorization: Basic ${secrets[6]}`,
          `DATABASE_PASSWORD=${secrets[7]}`,
          "Error: authentication failed"
        ].join("\n")
      }),
      {
        putText,
        readText: (sha256) => memoryStore.readText(sha256)
      }
    );

    const outputs = [
      await dispatch("read_pr_diff", {}),
      await dispatch("read_file", {
        path: `secrets-${secrets[4]}.txt`,
        start_line: 1,
        end_line: 3
      }),
      await dispatch("read_ci_log", {})
    ];
    const persistedLog = putText.mock.calls[0]?.[0] ?? "";

    for (const output of outputs) {
      const parsed = result(output);
      expect(parsed.redaction).toMatchObject({
        applied: true
      });
      expect(parsed.redaction.count).toBeGreaterThan(0);
      expect(parsed.redaction.disclosure).toContain(
        "before persistence or model exposure"
      );
      for (const secret of secrets) {
        expect(output).not.toContain(secret);
      }
    }
    for (const secret of secrets) {
      expect(persistedLog).not.toContain(secret);
    }
    expect(persistedLog).toContain("[REDACTED]");
  });

  it("rejects dishonest artifact-store receipts", async () => {
    const dishonestReceipts = [
      {
        sha256: "0".repeat(64),
        bytes: Buffer.byteLength(snapshot().ciLog, "utf8"),
        mediaType: "text/plain"
      },
      {
        sha256: digest(
          snapshot().ciLog.replace(/\r\n?/g, "\n")
        ),
        bytes: 1,
        mediaType: "text/plain"
      },
      {
        sha256: digest(
          snapshot().ciLog.replace(/\r\n?/g, "\n")
        ),
        bytes: Buffer.byteLength(
          snapshot().ciLog.replace(/\r\n?/g, "\n"),
          "utf8"
        ),
        mediaType: "application/json"
      }
    ];

    for (const receipt of dishonestReceipts) {
      const artifactStore = {
        putText: vi.fn().mockResolvedValue(receipt),
        readText: vi.fn()
      } as unknown as ArtifactStore;
      const dispatch = createPrReviewToolDispatcher(
        snapshot(),
        artifactStore
      );

      await expect(
        dispatch("read_ci_log", {})
      ).rejects.toMatchObject({
        code: "ARTIFACT_STORE_ERROR"
      });
    }
  });

  it("wraps artifact-store failures without exposing their message", async () => {
    const storeError = new Error("backend failure with stored-secret");
    const artifactStore: ArtifactStore = {
      putText: vi.fn().mockRejectedValue(storeError),
      readText: vi.fn()
    };
    const dispatch = createPrReviewToolDispatcher(
      snapshot(),
      artifactStore
    );

    const error = await dispatch("read_ci_log", {}).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(PrReviewToolError);
    expect(error).toMatchObject({
      code: "ARTIFACT_STORE_ERROR",
      cause: storeError
    });
    expect((error as Error).message).not.toContain("stored-secret");
  });

  it("caps every serialized tool result at 16 KiB with hashes and metadata", async () => {
    const hugeLine = `Error: ${"x".repeat(80_000)} \u{1f642}`;
    const dispatch = createPrReviewToolDispatcher(
      snapshot({
        diff: hugeLine,
        files: { "huge.txt": hugeLine },
        ciLog: hugeLine,
        ciExitCode: 1
      }),
      new MemoryArtifactStore()
    );

    const outputs = [
      await dispatch("read_pr_diff", {}),
      await dispatch("read_file", {
        path: "huge.txt",
        start_line: 1,
        end_line: 1
      }),
      await dispatch("read_ci_log", {})
    ];

    for (const output of outputs) {
      const parsed = result(output);
      expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(
        MAX_TOOL_RESULT_BYTES
      );
      expect(parsed.truncation).toMatchObject({
        truncated: true,
        maxBytes: MAX_TOOL_RESULT_BYTES
      });
      expect(parsed.truncation.returnedBytes).toBe(
        Buffer.byteLength(parsed.content, "utf8")
      );
      expect(parsed.truncation.omittedBytes).toBeGreaterThan(0);
      expect(parsed.contentSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(parsed.returnedContentSha256).toBe(digest(parsed.content));
    }
  });
});
