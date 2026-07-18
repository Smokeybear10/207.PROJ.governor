import type { JsonObject } from "../openai/index.js";

/**
 * Shared contracts for the governed CI-repair module.
 *
 * Every file in `server/repair/` codes against the interfaces declared here so
 * that the sandbox, tools, budget tools, workflow, and evaluator can be
 * implemented independently and integrate without drift. Do NOT widen or
 * rename these without updating every implementer.
 */

// --- Tool name registries (disjoint namespaces) ------------------------------

export const REPAIR_TOOL_NAMES = [
  "list_files",
  "read_file",
  "apply_patch",
  "run_tests"
] as const;
export type RepairToolName = (typeof REPAIR_TOOL_NAMES)[number];

export const BUDGET_TOOL_NAMES = [
  "budget_status",
  "estimate_action_cost",
  "check_completion_headroom"
] as const;
export type BudgetToolName = (typeof BUDGET_TOOL_NAMES)[number];

// --- Fixture + sandbox contracts (owned by sandbox implementer) --------------

/**
 * A broken-repo fixture template. `rootDir` is copied into a fresh temp working
 * copy for every run. Only `allowlistedPaths` may be read/edited by the agent;
 * `protectedPaths` (e.g. test files) must never be modified by a patch.
 */
export interface RepairFixture {
  readonly id: string;
  readonly rootDir: string;
  readonly allowlistedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly testCommand: readonly string[];
  readonly maxEditFiles: number;
}

export interface SandboxFileInfo {
  readonly path: string;
  readonly lines: number;
  readonly bytes: number;
}

export interface SandboxEdit {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

export interface SandboxApplyResult {
  readonly applied: boolean;
  readonly revision: string;
  readonly changedPaths: readonly string[];
  readonly rejected: readonly { readonly path: string; readonly reason: string }[];
}

export interface SandboxTestRun {
  readonly exitCode: number;
  readonly durationMs: number;
  /** UTF-8 stdout+stderr, hard-bounded to MAX_TEST_LOG_BYTES before return. */
  readonly stdout: string;
}

/**
 * An isolated, mutable working copy of a fixture. All destructive operations
 * (edits, test execution) happen only inside `dir`, never in the real repo.
 * `revision()` is a SHA-256 over the sorted allowlisted file contents and is
 * used as the retry-suppression `stateRevision`.
 */
export interface RepairSandbox {
  readonly id: string;
  readonly dir: string;
  readonly allowlistedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  revision(): string;
  listFiles(): readonly SandboxFileInfo[];
  readFile(path: string): string;
  applyEdits(edits: readonly SandboxEdit[]): SandboxApplyResult;
  runTests(signal?: AbortSignal): Promise<SandboxTestRun>;
  /** Allowlisted paths whose content differs from the original template. */
  editedPaths(): readonly string[];
  dispose(): Promise<void>;
}

// --- Toolbox contracts -------------------------------------------------------

/** Local OpenAI function-tool definitions + a JSON-string dispatcher. */
export interface RepairToolbox {
  readonly definitions: readonly JsonObject[];
  execute(name: string, args: unknown): Promise<string>;
  /** Current working-tree revision (for retry-suppression stateRevision). */
  revision(): string;
}

export interface BudgetToolbox {
  readonly definitions: readonly JsonObject[];
  execute(name: string, args: unknown): Promise<string>;
}

// --- Evaluation (sealed ground truth) ----------------------------------------

export interface RepairEvaluation {
  readonly passed: boolean;
  readonly targetPassed: boolean;
  readonly policyRespected: boolean;
  readonly exitCode: number;
  readonly violations: readonly string[];
}
