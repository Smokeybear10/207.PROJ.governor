import { verifyFinalState } from "./sandbox.js";
import type { RepairEvaluation, RepairFixture, RepairSandbox } from "./types.js";

/**
 * Sealed ground-truth evaluation. Verifies the change policy against the agent's
 * sandbox, then runs the pinned test command in a FRESH, pristine checkout that
 * carries over only the agent's allowlisted file contents (see
 * {@link verifyFinalState}). Working-tree test edits and tool-output claims
 * cannot substitute for this fresh run. Tests still share a process with the
 * generated code, so a zero exit status is not adversarial proof of correctness.
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

  // Snapshot the agent's final allowlisted contents and verify them in a fresh,
  // disposable checkout separate from the agent's sandbox.
  const finalContents = new Map<string, string>();
  for (const path of sandbox.allowlistedPaths) {
    finalContents.set(path, sandbox.readFile(path));
  }

  const run = await verifyFinalState(fixture, finalContents, signal);
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
