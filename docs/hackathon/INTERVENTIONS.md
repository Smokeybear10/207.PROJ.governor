# Intervention Checklist — Pitch Language vs. Implementation

Teammate notes, translated into plain English for the pitch and judge Q&A.
Each line maps to a mechanism in [`docs/TOKEN_GOVERNOR.md`](../TOKEN_GOVERNOR.md)
section 15 (Intervention Catalog) and section 11 (Cost Accounting). Status is
checked against the current code, not the spec, so this drifts as we build —
recheck before quoting a status in the demo.

## Built and wired into the enforcement kernel

- [x] **Count before you call** — exact input-token preflight through
  `POST /v1/responses/input_tokens` before every dispatch.
  `server/runtime/governed-executor.ts`
- [x] **Set money aside, then refund** — reserve the worst-case cost before
  dispatch, settle against actual provider usage after.
  `server/governor/ledger.ts`
- [x] **Cap the answer length** — conservative `max_output_tokens` computed
  from remaining safe budget before each response.
  `server/runtime/governed-executor.ts`
- [x] **Don't repeat dead-end work** — equivalent-retry suppression by
  canonical tool name/arguments/error class; transient failures don't burn
  the retry budget. `server/governor/retry.ts` (`RetryFingerprintTracker`)
- [x] **Shrink giant logs** — deterministic test-log reduction to exit code,
  failing tests, and relevant error lines before it ever reaches the model.
  `server/governor/log-reducer.ts` (`reduceTestLog`)
- [x] **Always keep enough to finish** — protected final-answer reserve the
  policy will not spend on investigation. `server/governor/index.ts`,
  policy `finalReserveMicros`
- [x] **Quit while you're ahead** — refuses a request if even the minimum
  safe next step can't fit in the remaining hard budget; stops cleanly
  instead of guessing. `server/runtime/governed-executor.ts`
- [x] **Look before you read** — `read_file` tool takes an explicit
  `start_line`/`end_line` range capped at 200 lines; no whole-file dumps.
  `server/review/tools.ts`

## Foundation exists, not wired as an active saving yet

- [ ] **Reuse instead of resend** — the artifact store is already
  content-addressed by SHA-256 (`server/artifacts/index.ts`), so identical
  content always hashes the same. But nothing in `review/tools.ts` checks
  "have we already served this exact read in this job?" and returns a short
  reference instead of the full payload. Next step: cache served
  `(tool, args, contentHash)` per job and return
  `"Unchanged from observation obs_N, sha256: ..."` on a repeat.
- [ ] **Reuse the repeated part of prompts (prompt caching)** — the rate
  card already prices cached vs. uncached input differently
  (`server/governor/cost.ts`), so the cost math is ready. Nobody has
  verified the instructions/tool-schema prefix is actually held stable
  across calls to land in the cached-input bucket in practice.

## Not implemented — real backlog items

- [ ] **Stop carrying dead weight (context compaction)** — only exists as
  narrated text in the demo fixtures (`server/demo/fixtures.ts`), not as
  real logic that drops old turns while preserving pinned state (objective,
  schema, confirmed findings). This is the "predictive shadow" arm's whole
  reason to exist — see docs/POC_FINDINGS.md, it's still shadow-only.
- [ ] **Only run the tests that matter** — not applicable to the current
  PR-review workflow (one fixed CI log per fixture). This is a CI-repair
  workflow idea; POC_FINDINGS.md's next-experiment section argues CI repair
  is actually the stronger economic wedge if anyone has hours left.
- [ ] **Save and undo cheaply (snapshot rollback)** — no revert-to-snapshot
  mechanism exists. Out of scope unless we pivot toward a code-editing
  workflow, which section 15.8 explicitly defers (automatic patching turns
  this back into SpendPatch).
- [ ] **Ignore unreliable/flaky tests** — no flaky-test detection. Retry
  suppression today treats every failure the same; distinguishing "this
  test is flaky" from "this is a real regression" is unbuilt.
- [ ] **Cheapest model that works (model routing)** — explicitly a
  non-goal for the hackathon (spec section 7.3, 15.8): switching models
  mid-job would break the "same quality, less cost" claim we're making.
  Don't build this before the demo; it's a roadmap item, not a gap.

## For the pitch

The judge-facing line: *"Six of these are live and enforced today — not
mocked, not simulated math. The other five are the honest roadmap, and two
of those (model routing, snapshot rollback) are things we deliberately did
NOT build, because they'd weaken the core claim."*
