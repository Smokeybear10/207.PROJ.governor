import type { RepairEvaluation, RepairFixture, RepairSandbox } from "./types.js";

/**
 * Sealed ground-truth evaluation. Runs the pinned test command FRESH against
 * the final working copy and verifies the change policy. This is never exposed
 * to the agent, so success cannot be gamed by manipulating tool output.
 *
 * Success requires: the target suite passes (exit code 0), no protected path
 * was modified, and the number of edited files does not exceed the fixture's
 * `maxEditFiles` policy.
 */
export async function evaluateRepair(
  sandbox: RepairSandbox,
  fixture: RepairFixture,
  signal?: AbortSignal
): Promise<RepairEvaluation> {
  const violations: string[] = [];

  const edited = sandbox.editedPaths();
  if (edited.length > fixture.maxEditFiles) {
    violations.push(
      `Edited ${edited.length} files, exceeding the ${fixture.maxEditFiles}-file change policy.`
    );
  }
  const protectedSet = new Set(fixture.protectedPaths);
  for (const path of edited) {
    if (protectedSet.has(path)) {
      violations.push(`Protected path "${path}" was modified.`);
    }
  }

  const run = await sandbox.runTests(signal);
  const targetPassed = run.exitCode === 0;
  const policyRespected = violations.length === 0;

  return Object.freeze({
    passed: targetPassed && policyRespected,
    targetPassed,
    policyRespected,
    exitCode: run.exitCode,
    violations: Object.freeze([...violations])
  });
}
