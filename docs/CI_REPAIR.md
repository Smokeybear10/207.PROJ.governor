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
[`../README.md`](../README.md#architecture)):

1. VS Code extension — editor-native CI-Repair controls
   (`vscode-extension/`).
2. Shared API — Express app exposing `POST /api/repair/runs` (`server/app.ts`).
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
(`budgetUsd` default `"1.00"`, pinned to `GPT_5_4_MINI_STANDARD_RATE_CARD`) and
exposes only `respond(...)` / `finalize(...)` plus a read-only `getAccounting()`
to `runGovernedRepair` (`server/repair/workflow.ts`). The workflow issues each
`work` and `final` response through the service; the service — not the agent —
decides whether a call is admitted and at what output cap, and maps denials to
`GOVERNOR_DENIED` / `PREFLIGHT_FAILED` / `PROVIDER_REJECTED`. The agent can *ask*
about the budget through read-only budget tools (which read the job's
`BudgetAccounting`), but it can never loosen the reserve gate.

## Non-negotiable safety boundary: destructive ops run in a sandbox

Any **destructive operation** — applying a patch or executing a test command —
runs **only inside an isolated, disposable working copy** of a fixture repo,
never against the real workspace:

- Each run copies the fixture template `rootDir` into a fresh OS temp directory
  (the sandbox `dir`). All edits and process execution happen there.
- `apply_patch` may only write to `allowlistedPaths`; `protectedPaths`
  (test files, CI config) are read-only and edits to them are rejected.
- `run_tests` executes a single **pinned** command (e.g. `node --test`) with a
  hard timeout and bounded, redacted output. The agent never gets a shell and
  cannot run arbitrary commands.
- The sandbox is disposed after the run (`finally`), so nothing escapes the
  temp directory.

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
| `hybrid` | real OpenAI `/input_tokens` (free) | scripted | $0 |
| `live` | real OpenAI | real OpenAI (`gpt-5-nano`) | ~$0.001/run |

`gpt-5-nano` has a rate card (`GPT_5_NANO_STANDARD_RATE_CARD`); the ledger pins
model → rates, so switching models is a one-line change. `live` mode requires
`OPENAI_API_KEY`.

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

- `list_files` — allowlisted paths + line/byte counts.
- `read_file` — inclusive 1-based line range from an allowlisted file (≤200 lines).
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
stray files, direct disk writes that bypass `apply_patch`) is discarded, so a
green verdict cannot be manufactured by tampering with the sandbox.

This ground truth is computed independently and is never exposed to the agent,
so success cannot be gamed by manipulating tool output. It also drives
`finalizeFinalResponse`, so a governed job only closes as accepted when the
sealed evaluation passes.

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
calls. The ledger is single-process memory and is not durable across restarts.
