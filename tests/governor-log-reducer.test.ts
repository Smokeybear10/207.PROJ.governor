import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_TEST_LOG_BYTES,
  REDACTION_DISCLOSURE,
  redactSensitiveText,
  reduceTestLog
} from "../server/governor/log-reducer.js";

describe("deterministic test-log reduction", () => {
  it("preserves failure evidence and raw artifact identity", () => {
    const noise = Array.from(
      { length: 300 },
      (_, index) => `debug worker output ${index}`
    ).join("\n");
    const rawLog = [
      "\u001b[31mFAIL  tests/math.test.ts > math > adds numbers\u001b[0m",
      "  AssertionError: expected 4 to be 5",
      "      at tests/math.test.ts:12:7",
      noise,
      "FAILED tests/api_test.py::test_auth - TypeError: missing token",
      "TypeError: missing token",
      "1 failed, 20 passed"
    ].join("\r\n");

    const first = reduceTestLog(rawLog, 1, {
      contextLines: 1,
      maxExcerptLines: 20
    });
    const second = reduceTestLog(rawLog, 1, {
      contextLines: 1,
      maxExcerptLines: 20
    });
    const normalizedLog = rawLog.replace(/\r\n?/g, "\n");

    expect(second).toEqual(first);
    expect(first.exitCode).toBe(1);
    expect(first.rawArtifact).toEqual({
      sha256: createHash("sha256")
        .update(normalizedLog, "utf8")
        .digest("hex"),
      bytes: Buffer.byteLength(normalizedLog, "utf8"),
      estimatedTokens: Math.ceil(
        Buffer.byteLength(normalizedLog, "utf8") / 4
      )
    });
    expect(first.failingTests.map((entry) => entry.name)).toEqual([
      "tests/math.test.ts > math > adds numbers",
      "tests/api_test.py::test_auth"
    ]);
    expect(
      first.relevantErrorLines.map((entry) => entry.text)
    ).toEqual(
      expect.arrayContaining([
        "AssertionError: expected 4 to be 5",
        "TypeError: missing token"
      ])
    );
    expect(first.text).toContain("Exit code: 1");
    expect(first.text).toContain(
      `Raw artifact SHA-256: ${first.rawArtifact.sha256}`
    );
    expect(first.text).toContain("Truncated: yes");
    expect(first.reducedArtifact.bytes).toBeLessThan(
      first.rawArtifact.bytes
    );
    expect(first.reducedArtifact.estimatedTokens).toBe(
      Math.ceil(first.reducedArtifact.bytes / 4)
    );
  });

  it("deduplicates repeated errors while retaining occurrence counts", () => {
    const rawLog = [
      "FAIL  tests/retry.test.ts > retry > stops",
      "Error: retry limit exceeded",
      "Error: retry limit exceeded",
      "Error: retry limit exceeded"
    ].join("\n");
    const reduction = reduceTestLog(rawLog, 1);

    expect(reduction.relevantErrorLines).toContainEqual({
      text: "Error: retry limit exceeded",
      firstLine: 2,
      occurrences: 3
    });
    expect(reduction.text).toContain(
      "L2: Error: retry limit exceeded [x3]"
    );
  });

  it("retains deterministic head and tail excerpts when no error is detected", () => {
    const rawLog = Array.from(
      { length: 50 },
      (_, index) => `passing output ${index + 1}`
    ).join("\n");
    const reduction = reduceTestLog(rawLog, 0, {
      maxExcerptLines: 8
    });

    expect(reduction.failingTests).toEqual([]);
    expect(reduction.relevantErrorLines).toEqual([]);
    expect(reduction.text).toContain("passing output 1");
    expect(reduction.text).toContain("passing output 50");
    expect(reduction.omittedOriginalLines).toBe(42);
  });

  it("redacts common credential forms before hashing and extraction", () => {
    const secrets = [
      "bearer-value-123",
      "dXNlcjpwYXNzd29yZA==",
      "service-token-value",
      "client-secret-value",
      "database-password-value",
      "assigned-api-key-value",
      "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
      "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD",
      "AKIAIOSFODNN7EXAMPLE",
      "private-key-material"
    ];
    const rawLog = [
      `Authorization: Bearer ${secrets[0]}`,
      `authorization=Basic ${secrets[1]}`,
      `SERVICE_TOKEN=${secrets[2]}`,
      `CLIENT_SECRET: "${secrets[3]}"`,
      `DB_PASSWORD='${secrets[4]}'`,
      `"INTERNAL_API_KEY": "${secrets[5]}"`,
      secrets[6],
      secrets[7],
      secrets[8],
      "-----BEGIN PRIVATE KEY-----",
      secrets[9],
      "-----END PRIVATE KEY-----",
      "Error: credentials were rejected"
    ].join("\r\n");

    const reduction = reduceTestLog(rawLog, 1);
    const serialized = JSON.stringify(reduction);
    const sanitized = redactSensitiveText(
      rawLog.replace(/\r\n?/g, "\n")
    );

    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
    expect(reduction.redaction).toEqual({
      applied: true,
      count: 10,
      disclosure: REDACTION_DISCLOSURE
    });
    expect(reduction.text).toContain("Credential redactions: 10");
    expect(reduction.rawArtifact).toMatchObject({
      sha256: createHash("sha256")
        .update(sanitized.text, "utf8")
        .digest("hex"),
      bytes: Buffer.byteLength(sanitized.text, "utf8")
    });
  });

  it("rejects an oversized log before reduction", () => {
    expect(() =>
      reduceTestLog("x".repeat(MAX_TEST_LOG_BYTES + 1), 1)
    ).toThrow(
      `rawLog exceeds the ${MAX_TEST_LOG_BYTES}-byte limit.`
    );
  });
});
