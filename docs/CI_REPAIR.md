# Governed CI-Repair — Design Spec

## Goal

The CI-Repair feature extends TokenGovernor from a read-only PR-review demo into
a **governed autonomous build-repair agent**: given a broken repository (failing
tests + logs), an AI agent reads evidence, proposes code edits, and re-runs
tests in a loop until the build is green — while the governor reserves worst-case
cost before every model call, caps output, settles real usage, and refuses any
call that would exceed the per-job budget.

CI-repair is the wedge argued for in [`POC_FINDINGS.md`](./POC_FINDINGS.md): it
has a machine-verifiable outcome (tests pass/fail) and repeated attempts, which
is exactly where reserve/cap/settle and retry-suppression earn their value.

## Layer boundaries

CI-repair is the third of TokenGovernor's four layers (see
[`../README.md`](../README.md#how-it-works)):

1. VS Code extension — editor-native CI-Repair controls
   (`vscode-extension/`).
2. Shared API — Express app exposing the sample `POST /api/repair/runs` and
   workspace `POST /api/repair/repository/runs` (`server/app.ts`).
3. **Repair layer — this feature** (`server/repair/**`).
4. Governor service — the enforcement engine the repair layer drives.

### The repair agent drives the governor, it does not embed the core

The repair layer contains **no cost or ledger logic of its own**. Every model
call is routed through `GovernedJobService` (`server/jobs/service.ts`) — the
single spend authority — which internally runs the same deterministic
count → reserve → cap → dispatch → settle engine (`server/runtime/**` +
`server/governor/**`) that also backs the public `/v1/jobs` endpoints.

`server/repair/api.ts` constructs one `GovernedJobService` per run (wired to the
selected `ResponsesProvider`) and the repair layer talks to it exclusively
through a thin typed adapter, `openRepairSession` in
`server/repair/governor-client.ts`. That adapter opens a job from a fixed policy
(`budgetUsd` `"2.00"` for the sample, pinned to `GPT_5_4_MINI_STANDARD_RATE_CARD`) and
exposes only `respond(...)` / `finalize(...)` plus a read-only `getAccounting()`
to `runGovernedRepair` (`server/repair/workflow.ts`). The workflow issues each
`work` and `final` response through the service; the service — not the agent —
decides whether a call is admitted and at what output cap, and maps denials to
`GOVERNOR_DENIED` / `PREFLIGHT_FAILED` / `PROVIDER_REJECTED`. The agent can *ask*
about the budget through read-only budget tools (which read the job's
`BudgetAccounting`), but it can never loosen the reserve gate.

## Execution boundary

Workspace repairs accept an explicit text snapshot, never a server filesystem
path. Source files are editable; selected tests and context are readable but
protected. The initial native test run must fail before model work starts.
Unsupported imports/runtime failures stop without a model call. Run IDs bind
the full snapshot and policy; repeated submissions retrieve the same run, while
changed payloads with the same ID are rejected. Poll
`GET /api/repair/repository/runs/:requestId` for completion.

Checkpoints contain the last patch and job ID. A restart marks an unfinished
run failed and exposes its checkpoint for review; it never replays generation.
Native tests, including final verification, use the same selected files and a
fixed TAP reporter. This path supports Node's built-in test runner only.

Repair tools operate on a disposable fixture copy. Execution currently requires
macOS with `sandbox-exec` and standalone Node.js 22.8 or later on `PATH`:

- Each run copies the fixture template `rootDir` into a fresh OS temp directory
  (the sandbox `dir`). Test processes start with that working directory.
- `apply_patch` may only write to `allowlistedPaths`; `protectedPaths`
  (test files, CI config) are read-only and edits to them are rejected.
- `run_tests` executes the pinned Node command under a deny-by-default native
  policy. It can read the fixture and required runtime files, but cannot write
  files, use the network, or spawn subprocesses. Node tests run in one process.
- Runtime discovery and an isolated startup probe finish before any model work.
  Unsupported platforms, runtimes, or profiles fail closed. No provider mode
  enables an unrestricted host fallback.
- Runs keep the wall-clock timeout and bounded log capture. Aborting a sandbox
  command kills its process; the temporary copy is removed after the run.
  Cancelling workspace progress in the editor only stops watching, while the
  approved repair continues.

The native macOS launcher is deprecated by Apple and its policy format is a
platform-specific interface. This implementation is tested on macOS; Linux and
Windows repair execution are not implemented. It is not a VM or a complete
memory/CPU quota system. The test harness shares a process with generated code,
so isolation protects the host but does not make test results tamperproof.

The OpenAI adapter continues to permit **local function tools only**
(`assertContext` rejects non-`function` tools), so the provider's native
`shell`/`apply_patch` tool types are deliberately NOT used.

## Provider modes (free testing strategy)

`GOVERNOR_PROVIDER_MODE` (or the `mode` field of `POST /api/repair/runs`) selects
the provider behind the unchanged `ResponsesProvider` seam via
`server/openai/provider-factory.ts`:

| Mode | `countInput` | `createResponse` | Cost |
|------|-------------|------------------|------|
| `fake` | scripted | scripted | $0 (default; CI/offline) |
| `hybrid` | real OpenAI `/input_tokens` | scripted | no generated output |
| `live` | real OpenAI | real OpenAI (`gpt-5.4-mini`) | provider usage at the pinned rate card |

The ledger pins `GPT_5_4_MINI_STANDARD_RATE_CARD`. Direct API `live` mode requires
`OPENAI_API_KEY`. These mode selectors apply to direct sample API requests.
The editor's **Run sample** action always requests `fake`; its legacy
`tokenGovernor.providerMode` setting is ignored. Workspace repairs always use
the configured live provider, with the managed service receiving its key from
VS Code Secret Storage.

## Loop shape

```
create sandbox (temp working copy of fixture)
loop (bounded by policy.maxResponses; each response governed):
  model turn -> at most one tool call (parallel_tool_calls disabled)
    list_files / read_file -> evidence into transcript
    apply_patch            -> mutate sandbox; recompute stateRevision
    run_tests              -> exit 0 => break to final summary
  retryTracker.observe(..., stateRevision) suppresses no-progress repeats
stop when:
  passed  run_tests passes    -> governed final "summary of fix" response
  stopped ledger denies       -> not_repaired (WORK_DENIED / budget)
  stopped maxResponses reached-> not_repaired (MAX_RESPONSES_REACHED)
seal: evaluateRepair() re-runs tests in a fresh pristine checkout (allowlisted
      contents only) + checks change policy (agent-invisible)
dispose sandbox
```

## Custom tools

Base repair tools (`server/repair/tools.ts`), all strict local function tools
returning ≤16 KB JSON, with large payloads spilled to the content-addressed
artifact store and `run_tests` output reduced via `reduceTestLog`:

- `list_files` — approved source/context paths, edit permissions, and line/byte counts.
- `read_file` — inclusive 1-based line range from an approved file (≤200 lines).
- `apply_patch` — array of exact `{ path, old_text, new_text }` search/replace
  edits; rejected if `old_text` is absent/ambiguous or `path` is not allowlisted.
- `run_tests` — runs the pinned command; returns exit code + reduced log + revision.

Budget-aware tools (`server/repair/budget-tools.ts`), read-only shims over the
job's `BudgetAccounting` + pure pricing functions (they **inform, never loosen**,
the real reserve gate):

- `budget_status` — categorical risk band + responses remaining + budget-used band.
- `estimate_action_cost` — dry-run worst-case reserve for a prospective output size.
- `check_completion_headroom` — "can I still afford a valid final answer?"

## Sealed evaluation

`evaluateRepair(sandbox, fixture)` (`server/repair/evaluation.ts`) returns
`passed` only if **all** of the following hold:

- `targetPassed` — exit code 0 (the target suite passes).
- no `protectedPaths` were edited.
- the edited-file count does not exceed the fixture's `maxEditFiles` policy.

Crucially, `targetPassed` is **not** measured in the agent's own sandbox.
`verifyFinalState` (`server/repair/sandbox.ts`) copies the **pristine** fixture
into a brand-new throwaway temp directory, overlays **only** the agent's final
allowlisted file contents, and runs the pinned command there. Anything the agent
may have touched outside the allowlist inside its working tree (protected paths,
stray files, direct disk writes that bypass `apply_patch`) is discarded before
verification. Final verification uses the same native execution policy, so
generated code cannot modify files during that run either.

The test result is computed independently of the model's claimed result. It drives
`finalizeFinalResponse`, so a governed job only closes as accepted when the
sealed evaluation passes. A malicious implementation can still exit early or
interfere with the in-process test harness; acceptance is a test result, not
proof of correctness against adversarial code.

## Run and response shape

`POST /api/repair/runs` with `{ "fixtureId": "broken-sum", "mode": "fake" }`
returns a governed result (`GovernedRepairResult`) alongside run metadata
(`fixtureId`, `mode`, `model`, `rateCardVersion`, `policy`):

- `status` — `repaired` or `not_repaired` (with a `reason` on failure).
- `evaluation` — the sealed verdict (`passed`, `targetPassed`, `policyRespected`,
  `exitCode`, `violations`).
- `finalText` — the agent's governed summary of the fix (or of why it could not
  repair).
- `trace` — ordered governed events (`response`, `tool`, and suppressed `retry`),
  each carrying a `LedgerSnapshot`.
- `snapshot.settledMicroUsd` — reconciled spend for the run, in integer micro-USD.

## Module layout

- `server/repair/types.ts` — shared contracts (fixture, sandbox, toolboxes, evaluation).
- `server/artifacts/index.ts` — content-addressed artifact store.
- `server/repair/sandbox.ts` — temp working copy + pinned runner + tree hashing.
- `server/repair/fixtures/` — self-contained broken-repo fixtures (no deps).
- `server/repair/tools.ts` — base repair toolbox.
- `server/repair/budget-tools.ts` — budget-aware toolbox.
- `server/repair/evaluation.ts` — sealed quality gate.
- `server/repair/workflow.ts` — `runGovernedRepair` loop.
- `server/repair/demo-script.ts` — scripted agent for `fake`/`hybrid` modes.
- `server/repair/api.ts` — `runRepairDemo` wiring (ledger, provider, sandbox).
- `server/repair/index.ts` — barrel exports.
- `server/openai/provider-factory.ts` — fake/hybrid/live selector.
- `server/app.ts` — `POST /api/repair/runs` route.

## Truth boundary

In `fake` and `hybrid` modes no billable model generation occurs; usage is
scripted or free, and all displayed cost is a calculated list-price figure from
the pinned rate card, not an invoice. Only `live` mode makes billable OpenAI
calls. The managed service persists the linked job's ledger and response receipts.
Workspace runs also save their latest patch; interrupted execution does not
resume automatically. Direct `runRepairDemo()` calls without a supplied service
use an in-memory ledger.
