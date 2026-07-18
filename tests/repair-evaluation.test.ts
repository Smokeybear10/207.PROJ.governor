import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateRepair } from "../server/repair/evaluation.js";
import { getRepairFixture } from "../server/repair/fixtures.js";
import { createRepairSandbox } from "../server/repair/sandbox.js";

const BUGGY_ADD = "export function add(a, b) {\n  return a - b;\n}";
const FIXED_ADD = "export function add(a, b) {\n  return a + b;\n}";

describe("sealed evaluator (isolated checkout)", () => {
  it("passes only when the allowlisted fix genuinely makes the pinned tests green", async () => {
    const fixture = getRepairFixture("broken-sum");
    const sandbox = await createRepairSandbox(fixture);
    try {
      const applied = sandbox.applyEdits([
        { path: "src/calculator.mjs", oldText: BUGGY_ADD, newText: FIXED_ADD }
      ]);
      expect(applied.applied).toBe(true);

      const evaluation = await evaluateRepair(sandbox, fixture);
      expect(evaluation.passed).toBe(true);
      expect(evaluation.targetPassed).toBe(true);
      expect(evaluation.policyRespected).toBe(true);
      expect(evaluation.exitCode).toBe(0);
      expect(evaluation.violations).toEqual([]);
    } finally {
      await sandbox.dispose();
    }
  });

  it("cannot be gamed by tampering with the sandbox working tree outside the allowlist", async () => {
    const fixture = getRepairFixture("broken-sum");
    const sandbox = await createRepairSandbox(fixture);
    try {
      // The agent does NOT fix the allowlisted source. Instead it tampers with
      // the protected test file directly on disk in its own sandbox, overwriting
      // it with a trivially-passing suite. Under an in-sandbox evaluator this
      // would report success; the isolated checkout must ignore it.
      writeFileSync(
        join(sandbox.dir, "test/calculator.test.mjs"),
        'import { test } from "node:test";\ntest("noop", () => {});\n',
        "utf8"
      );

      // Sanity: running in the tampered sandbox itself now (falsely) passes.
      const inSandbox = await sandbox.runTests();
      expect(inSandbox.exitCode).toBe(0);

      // The sealed evaluator runs the pinned tests in a pristine checkout that
      // carries over only allowlisted contents, so the unfixed bug is exposed.
      const evaluation = await evaluateRepair(sandbox, fixture);
      expect(evaluation.targetPassed).toBe(false);
      expect(evaluation.passed).toBe(false);
      expect(evaluation.exitCode).not.toBe(0);
    } finally {
      await sandbox.dispose();
    }
  });
});
