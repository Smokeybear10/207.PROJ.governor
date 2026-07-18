# Governor POC Findings

## Verdict

Continue, but narrow the claim.

The POC supports a credible deterministic middleware claim: an application can
place a conservative, auditable cost boundary around each model response before
dispatch. It does not support a forecasting, savings, invoice-control, or
production-readiness claim.

The scripted local scenarios are a mechanism walkthrough, not a holdout
benchmark. Their hard-cap, static, and predictive-shadow results are
deterministic fixtures.
Static and shadow have identical synthetic cost because the shadow signal is
not allowed to act. Separately, the multi-step review workflow is exercised
against a scripted fake Responses provider, not a live OpenAI account.

## What is implemented

- Fixed-point list-price cost calculation with versioned rate cards
- Exact proposed-input preflight through the Responses input-token endpoint
- Worst-case request reservation before dispatch and provider-usage settlement
- One unresolved response at a time, bounded responses, and output caps
- A protected final-answer reserve
- Canonical context and dispatched-request hashes; reservations pin provider,
  model, request/pricing tier, processing region, and rate-card version
- Provider response model/tier checks and explicit application validation of a
  settled final response before the job closes
- Conservative safe-stop behavior for transport ambiguity, missing usage, and
  usage mismatch
- Local function tools only, with parallel tool calls and provider storage off
- Equivalent-retry suppression against a trusted immutable snapshot, plus
  deterministic test-log reduction
- Bounded content-addressed raw artifact storage
- A multi-step pull-request review tested with a scripted fake provider
- Reconciled synthetic receipts and quality-gated comparison fixtures

The tests establish internal accounting invariants and deterministic behavior.
They do not establish provider behavior under a real account or distributed
correctness across processes.

## What remains unproven

- No live OpenAI request was made for the workflow tests or displayed
  scenarios.
- Exact preflight and terminal usage were tested against a fake transport, not
  reconciled against an OpenAI invoice.
- The pinned rate card is an application input and can become stale.
- The ledger and active workflow state are in-memory. They do not survive a
  process restart and have no transactional cross-process lock or recovery.
- Raw file artifacts are permission-restricted but not encrypted or redacted.
- Tool implementations, tenant authorization, retention, and audit export are
  outside this POC.
- The PR-review fixtures do not establish production demand or attractive unit
  economics.
- The shadow heuristic has no measured calibration, decision lift, or savings.

## Product finding

Deterministic enforcement is the product until prediction proves otherwise.
The more defensible initial wedge is outcome-gated spend allocation for a
high-volume autonomous CI-repair workflow. CI repair has frequent repeated
attempts, large logs, a machine-verifiable outcome, and enough volume for a
controller experiment. Pull-request review remains useful as a mechanism
fixture but is a weak economic proof.

## Next falsification experiment

Freeze a set of previously unseen CI failures and a task policy before running
any treatment. Use real provider calls and preserve every assigned job,
including failures and policy stops.

1. Pre-register the task sample, repair-rate non-inferiority margin, minimum
   detectable cost effect, sample size, and stopping rule before inspecting
   treatment results.
2. Run a hard-cap baseline and a competent static controller. Randomize
   treatment assignment within task strata, and keep every assigned job in the
   analysis.
3. Log the risk forecast in shadow on the static arm; it cannot alter execution.
4. At forecast/static decision disagreements, fork matched continuations from
   the same prefix into static and forecast-recommended actions.
5. Score success only from the resulting CI state: target tests pass, no
   protected tests regress, and the patch satisfies a fixed change policy.
6. Fix the number of stochastic repeats per task in advance. Analyze paired
   continuations by task rather than treating repeated runs as independent
   jobs.
7. Reconcile provider usage and the pinned rate card for every response.
8. Compare cost only after both treatments satisfy the frozen quality gate.

The primary decision test should be assigned-job repair-rate non-inferiority.
Conditional on passing it, compare paired total calculated cost and report a
task-clustered confidence interval for the cost ratio. Successful repairs per
calculated dollar is a secondary summary, not a substitute for quality. Report
assigned-job totals, policy stops, and failures rather than completed-job
averages, and do not stop early because an interim result looks favorable.

Stop investing in prediction if any of these occur:

- Too few jobs reach a genuine static-versus-forecast decision disagreement.
- Forecast recommendations do not improve outcomes at disagreement points.
- Apparent savings come primarily from abandoning unsuccessful jobs.
- Model spend is too small a share of CI-repair cost to matter.
- A simpler static retry, context, or output rule captures the same benefit.

Until that experiment passes, keep every forecast shadow-only and make no
savings claim.
