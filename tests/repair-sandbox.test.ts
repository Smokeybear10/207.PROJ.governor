import { describe, expect, it } from "vitest";

import { getRepairFixture } from "../server/repair/fixtures.js";
import { createRepairSandbox } from "../server/repair/sandbox.js";

const BUGGY_ADD = "export function add(a, b) {\n  return a - b;\n}";
const FIXED_ADD = "export function add(a, b) {\n  return a + b;\n}";

describe("repair sandbox (broken-sum)", () => {
  it("fails, accepts a valid fix, and rejects illegal edits", async () => {
    const fixture = getRepairFixture("broken-sum");
    const sandbox = await createRepairSandbox(fixture);

    try {
      expect(sandbox.allowlistedPaths).toContain("src/calculator.mjs");

      const listed = sandbox.listFiles();
      expect(listed.map((info) => info.path)).toEqual(["src/calculator.mjs"]);
      expect(listed[0].bytes).toBeGreaterThan(0);
      expect(listed[0].lines).toBeGreaterThan(0);

      const revisionBefore = sandbox.revision();
      const source = sandbox.readFile("src/calculator.mjs");
      expect(source).toContain(BUGGY_ADD);

      const failing = await sandbox.runTests();
      expect(failing.exitCode).not.toBe(0);
      expect(failing.durationMs).toBeGreaterThanOrEqual(0);
      expect(sandbox.editedPaths()).toEqual([]);

      // Reading a non-allowlisted path throws.
      expect(() => sandbox.readFile("test/calculator.test.mjs")).toThrow();

      // Edit to a non-allowlisted (protected) path is rejected all-or-nothing.
      const badPath = sandbox.applyEdits([
        {
          path: "test/calculator.test.mjs",
          oldText: "add",
          newText: "sub"
        }
      ]);
      expect(badPath.applied).toBe(false);
      expect(badPath.changedPaths).toEqual([]);
      expect(badPath.rejected).toHaveLength(1);
      expect(badPath.rejected[0].path).toBe("test/calculator.test.mjs");

      // Edit whose oldText does not exist is rejected.
      const missing = sandbox.applyEdits([
        {
          path: "src/calculator.mjs",
          oldText: "this text is not present anywhere",
          newText: "noop"
        }
      ]);
      expect(missing.applied).toBe(false);
      expect(missing.rejected[0].reason).toMatch(/not found/i);

      // Ambiguous oldText (occurs multiple times) is rejected.
      const ambiguous = sandbox.applyEdits([
        {
          path: "src/calculator.mjs",
          oldText: "a, b",
          newText: "a, b /* x */"
        }
      ]);
      expect(ambiguous.applied).toBe(false);
      expect(ambiguous.rejected[0].reason).toMatch(/ambiguous/i);

      // None of the rejected edits mutated the working copy.
      expect(sandbox.editedPaths()).toEqual([]);
      expect(sandbox.revision()).toBe(revisionBefore);

      // Apply the correct fix.
      const applied = sandbox.applyEdits([
        {
          path: "src/calculator.mjs",
          oldText: BUGGY_ADD,
          newText: FIXED_ADD
        }
      ]);
      expect(applied.applied).toBe(true);
      expect(applied.changedPaths).toEqual(["src/calculator.mjs"]);
      expect(applied.rejected).toEqual([]);

      const revisionAfter = sandbox.revision();
      expect(revisionAfter).not.toBe(revisionBefore);
      expect(applied.revision).toBe(revisionAfter);
      expect(sandbox.editedPaths()).toEqual(["src/calculator.mjs"]);
      expect(sandbox.readFile("src/calculator.mjs")).toContain(FIXED_ADD);

      const passing = await sandbox.runTests();
      expect(passing.exitCode).toBe(0);
    } finally {
      await sandbox.dispose();
    }
  });
});
