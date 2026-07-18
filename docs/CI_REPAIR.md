# Governed CI-Repair — Design Spec

## Goal

Extend TokenGovernor from a read-only PR-review demo into a **governed CI-repair
agent**: given a broken repository (failing tests + logs), an AI agent reads
evidence, proposes code edits, and re-runs tests in a loop until the build is
green — while the governor reserves worst-case cost before every model call,
caps output, settles real usage, and refuses any call that would exceed the
per-job budget.

CI-repair is the wedge argued for in `POC_FINDINGS.md`: it has a
machine-verifiable outcome (tests pass/fail) and repeated attempts, which is
exactly where reserve/cap/settle and retry-suppression earn their value.

## Non-negotiable safety boundary: destructive ops run in a sandbox dev environment

Any **destructive operation** — applying a patch or executing a test command —
runs **only inside an isolated, disposable working copy** of a fixture repo,
never against the real workspace:

- Each run copies the fixture template `rootDir` into a fresh OS temp directory
  (the sandbox `dir`). All edits and process execution happen there.
- `apply_patch` may only write to `allowlistedPaths`; `protectedPaths`
  (test files, CI config) are read-only and edits to them are rejected.
- `run_tests` executes a single **pinned** command (e.g. `node --test`) with a
  hard timeout and a bounded, redacted output. The agent never gets a shell and
  cannot run arbitrary commands.
- The sandbox is disposed after the run. Nothing escapes the temp directory.

The OpenAI adapter continues to permit **local function tools only**
(`assertContext` rejects non-`function` tools), so the provider's native
`shell`/`apply_patch` tool types are deliberately NOT used.

## Provider modes (free testing strategy)

`GOVERNOR_PROVIDER_MODE` selects the provider behind the unchanged
`ResponsesProvider` seam:

| Mode | `countInput` | `createResponse` | Cost |
|------|-------------|------------------|------|
| `fake` | scripted | scripted | $0 (default; CI/offline) |
| `hybrid` | real OpenAI `/input_tokens` (free) | scripted | $0 |
| `live` | real OpenAI | real OpenAI (`gpt-5-nano`) | ~$0.001/run |

`gpt-5-nano` has a rate card (`GPT_5_NANO_STANDARD_RATE_CARD`); the ledger pins
model→rates, so switching models is a one-line change.

## Loop shape

```
create sandbox (temp working copy of fixture)
loop (bounded by policy.maxResponses; each response governed):
  model turn → at most one tool call (parallel_tool_calls disabled)
    list_files / read_file → evidence into transcript
    apply_patch            → mutate sandbox; recompute stateRevision
    run_tests              → exit 0 ⇒ break to final summary
  retryTracker.observe(..., stateRevision) suppresses no-progress repeats
stop when:
  ✓ run_tests passes         → governed final "summary of fix" response
  ✗ ledger denies (budget)   → POLICY_STOPPED
  ✗ maxResponses reached     → UNRESOLVED
seal: evaluateRepair() re-runs tests fresh + checks change policy (agent-invisible)
dispose sandbox
```

## Custom tools

Base repair tools (`server/repair/tools.ts`), all strict local function tools
returning ≤16 KB JSON, large payloads spilled to the content-addressed artifact
store, `run_tests` output reduced via `reduceTestLog`:

- `list_files` — allowlisted paths + line/byte counts.
- `read_file` — inclusive 1-based line range from an allowlisted file (≤200 lines).
- `apply_patch` — array of exact `{path, old_text, new_text}` search/replace edits;
  rejected if `old_text` is absent/ambiguous or `path` is not allowlisted.
- `run_tests` — runs the pinned command; returns exit code + reduced log + revision.

Budget-aware tools (`server/repair/budget-tools.ts`), read-only shims over the
ledger snapshot + pure pricing functions (they inform, never loosen, the real
`reserve()` gate):

- `budget_status` — categorical risk band + responses remaining + budget-used band.
- `estimate_action_cost` — dry-run worst-case reserve for a prospective output size.
- `check_completion_headroom` — "can I still afford a valid final answer?"

## Sealed evaluation

`evaluateRepair(sandbox, fixture)` runs the pinned test command **fresh** in the
final working copy and returns success iff: exit code 0 (target passes), no
`protectedPaths` were edited, and edit count ≤ `maxEditFiles`. This ground truth
is never exposed to the agent, so success cannot be gamed.

## Module layout

- `server/repair/types.ts` — shared contracts (already defined).
- `server/artifacts/index.ts` — content-addressed artifact store (was missing).
- `server/repair/sandbox.ts` — temp working copy + pinned runner + tree hashing.
- `server/repair/fixtures/` — self-contained broken-repo fixtures (no deps).
- `server/repair/tools.ts` — base repair toolbox.
- `server/repair/budget-tools.ts` — budget-aware toolbox.
- `server/repair/evaluation.ts` — sealed quality gate.
- `server/repair/workflow.ts` — `runGovernedRepair` loop.
- `server/repair/index.ts` — barrel exports.
- `server/openai/provider-factory.ts` — fake/hybrid/live selector.
- `server/repair/api.ts` + `server/app.ts` — `POST /api/repair/runs`.
