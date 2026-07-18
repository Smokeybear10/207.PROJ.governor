# Governor

> The budget-aware execution layer for AI agents.

**Status:** Adversarially revised Ramp Hackathon product and technical specification
**Recommended scope:** Two engineers, one application-owned AI workflow  
**Evaluation workload:** AI pull-request review with seeded and clean cases  
**Commercial wedge:** One high-volume workflow with machine-verifiable outcomes  
**Core evidence:** Hold task success above a fixed gate, then compare total
calculated API cost across all assigned jobs  
**Prediction status:** Shadow-only until it beats the same controller without
prediction  
**Repository status:** The primary POC customer experience is the terminal CLI
and versioned governed-jobs API. The deterministic enforcement path is
implemented, and the multi-step review workflow is tested through a scripted
fake provider. The optional dashboard is a deterministic mechanism walkthrough
using synthetic fixtures; no live OpenAI call, measured benchmark, or savings
result exists. The ledger and active workflow state are single-process memory,
not durable or cross-process safe.
See `docs/POC_FINDINGS.md` for the implemented boundary and adversarial verdict.

## 1. Executive Overview

Governor is a budget-aware runtime for multi-step AI jobs. Its safety layer
counts the next request, reserves a conservative worst-case amount before
dispatch, allows only one model response in flight, settles the reservation
from provider-reported usage, and applies deterministic controls to context,
tool output, and retries.

Its optimization layer estimates whether a job is `SAFE`, `WATCH`, or
`AT_RISK`. That estimate begins in shadow mode: it is recorded but cannot
change execution. It earns control only if a holdout experiment shows that it
makes better decisions than a competent static controller at the same observed
task-success level.

The central distinction is:

- A hard cap stops an agent when no safe next call fits.
- Static controls always apply the same retry and context rules.
- Governor aims to apply the right control only when the job needs it, so
  more work finishes inside the same budget policy.

In the implemented fake-provider workflow, a pull-request review receives a
preset task-class policy rather than a user-entered penny-scale budget. Before
each scripted response, Governor counts the input, reserves the maximum
permitted output cost, and preserves a final-answer reserve. When a test
returns a large log, a deterministic reducer keeps the exit code, failing
tests, relevant error lines, and an artifact hash instead of inserting the
entire log into future context.

The scripted dashboard compares:

1. A hard cap with no context optimization.
2. A static controller with fixed production-grade hygiene.
3. The same controller with the shadow forecast as the only additional signal.

The predictive claim survives only if the third system makes materially better
decisions. Otherwise, the honest product is deterministic budget middleware.

## 2. The Idea in Plain English

An AI agent often makes several model calls while completing one request. It
may inspect files, call tools, run tests, read large outputs, and retry failed
steps. Counting the first prompt does not reveal the cost of the complete job,
and provider usage is normally final for a response only after that response
returns.

Governor puts a controlled boundary around every call:

```text
Team cost policy + user task
            |
            v
+-----------------------------------+
|          Governor            |
|                                   |
|  Safety layer                     |
|  count -> reserve -> cap -> settle|
|                                   |
|  Optimization layer               |
|  observe -> risk band -> shadow   |
+-----------------------------------+
            |
            v
OpenAI Responses API <-> local tools
            |
            v
Outcome, usage, policy, and quality receipt
```

Before and after each model response, it asks:

1. What is the exact input-token count for the proposed request?
2. What is the request's maximum calculated list-price cost?
3. Does that ceiling fit after preserving the final-answer reserve?
4. What usage did the completed response report?
5. Is execution `SAFE`, `WATCH`, or `AT_RISK`?
6. Is the risk estimate only observing, or has it earned authority?
7. Should deterministic policy continue, reduce output, reject a retry, or
   stop?

## 3. One-Sentence and Thirty-Second Pitches

### One sentence

Governor helps more AI-agent jobs finish under the same cost policy by
reserving every model call and adapting expensive context and retries before a
hard cap stops the work.

### Thirty seconds

AI-agent costs grow across multiple model calls, tools, retries, and expanding
context. Governor reserves the worst-case cost of each request before it
runs, settles reported usage afterward, and safely reduces large tool output or
repeated work when a job becomes risky. The current demo is a deterministic
scripted comparison, not a live benchmark. Quality must clear a real fixed
holdout gate before any savings claim is shown.

### High-level paragraph

Governor is a budget-aware runtime for one controlled AI workflow. It
turns a team-level cost policy into safe per-call reservations, deterministic
context and retry controls, and an auditable execution trace. A lightweight
forecast initially runs in shadow mode and is promoted only if it helps more
jobs finish within the same budget without an observed decline on a
precommitted quality benchmark.

## 4. Precise Product Definition

### 4.1 What is an AI job?

An AI job is the complete unit of work whose outcome matters, not one API
request.

For the evaluation fixture:

- **Job:** Review one pull request and return structured findings.
- **Start:** The task-class policy assigns a cost ceiling before execution.
- **End:** The agent returns a final review, cannot safely fund another call,
  fails, or is cancelled.
- **Success:** The sealed final output satisfies a predefined deterministic
  rubric that was unavailable to the agent and governor.

Pull-request review is an understandable benchmark, not necessarily the
commercial wedge. The strongest production buyer would operate one
high-volume workflow such as automated CI failure remediation, where outcome
quality is machine-verifiable and tail-cost variance is financially material.

### 4.2 What is a step?

A step is one controllable Responses API request plus any local custom-tool
execution it requests. The MVP excludes hosted tools, MCP tools, parallel tool
calls, and automatic retries because they can perform additional paid work
before control returns.

Every model request has two phases:

- **Admission:** Count input, calculate a conservative maximum cost, reserve
  that amount atomically, and set a maximum output allowance.
- **Settlement:** Read terminal provider usage, calculate list-price API cost,
  release unused reservation, and record the result.

The implemented admission path canonicalizes and hashes the counted context,
binds model, default request tier, processing region, provider, and rate-card
version to the reservation's pricing identity, and hashes the exact dispatched
request. Settlement checks terminal model and tier. A completed final response
does not close the job until the application explicitly validates its output.

### 4.3 Key terms

| Term | Meaning |
| --- | --- |
| Team envelope | Aggregate spending authority set outside an individual task. |
| Task-class policy | An automatic cost ceiling and quality rule for one type of job. |
| Hard application cap | A conservative list-price ceiling enforced by request admission. |
| Reservation | Worst-case amount held before one request is dispatched. |
| Settled cost | List-price cost calculated from provider-reported terminal usage. |
| Final-answer reserve | Amount protected so investigation cannot consume the completion path. |
| Risk band | `SAFE`, `WATCH`, or `AT_RISK`; not a calibrated probability. |
| Static controller | Fixed context, retry, and output rules without a learned forecast. |
| Predictive controller | The same rules with a forecast as an additional decision signal. |
| Shadow mode | Records recommendations but cannot alter execution. |
| Intervention | A deterministic change to remaining execution. |
| Quality gate | Minimum task-success result required before cost comparisons are valid. |
| Trace | Ordered record of requests, reservations, tools, usage, decisions, and outcomes. |

## 5. The Problem

AI cost dashboards explain completed spending. Token caps can limit one
response or stop a rollout. Neither alone answers whether a multi-step job can
finish useful work inside a cost policy.

Agent costs vary because:

- The initial prompt is only the first request.
- Tool results become future model input.
- Context grows across phases.
- Reasoning and output length vary.
- Failed tools cause retries.
- Large unique logs can enter context.
- Cached, uncached, and cache-write input can have different prices.
- Service tier, region, and hosted tools can alter cost.
- Exact usage is normally available only after a response terminates.

The practical problem is:

> "Under the same cost and quality policy, can the runtime help more agent jobs
> complete successfully than a hard stop or fixed rules alone?"

## 6. Target User and Job to Be Done

### Primary user

An AI platform lead operating one centrally owned, high-volume workflow with
stable task classes, direct control of the agent loop, machine-verifiable
outcomes, and material tail-cost variance.

### Budget ownership

- Finance or FinOps sets a team or application envelope.
- Product defines cost-per-outcome and quality targets.
- Platform engineering converts those targets into task-class policies.
- Individual users do not approve routine penny-scale model calls.

### Job to be done

> "Enforce a cost policy for every job, preserve a path to completion, and show
> whether adaptive control improves cost without reducing observed success."

### Why pull-request review is the evaluation fixture

- It is understandable to a hackathon audience.
- The agent can use file, search, and test tools.
- Context and tool-output sizes vary.
- Seeded bugs and clean controls support deterministic scoring.
- The same frozen tasks can run under three controllers.

The commercial story should emphasize a higher-volume workflow such as CI
failure remediation rather than the value of saving a few cents on one review.

## 7. Product Thesis and Honest Boundaries

### 7.1 The defensible claim

Before experiments, the only safe claim is:

> In fake-provider tests, Governor enforces a conservative
> application-level cost policy for a restricted Responses-style workflow and
> records a shadow risk signal that cannot change execution.

After a successful three-arm holdout, the project may additionally claim:

> On this synthetic benchmark with real OpenAI calls, the predictive controller
> reduced calculated list-price API cost relative to the same static controller
> with no observed decline under the precommitted success criteria.

### 7.2 Claims the project should not make

Do not claim:

- A universal or exact final-cost predictor.
- Calibrated P90 or overrun probabilities from a small dataset.
- Guaranteed quality preservation.
- Invoice reconciliation or exact company spend.
- A hard-dollar cap around arbitrary Codex SDK turns.
- Safe inspection of opaque native compaction output.
- That static context hygiene requires prediction.
- That a synthetic benchmark proves production demand.
- Guaranteed savings or broad workflow generalization.

### 7.3 Non-goals for the hackathon

- Multiple providers, models, tiers, or regions.
- Hosted tools, MCP tools, or parallel tool calls.
- Native opaque compaction as the primary intervention.
- Automatic model switching.
- Organization-wide cost attribution.
- A universal proxy around arbitrary agents.
- Production multi-tenancy.
- Calibrated probability claims.
- Multicalibration or causal claims.

## 8. User Experience

### 8.1 Main workflow

1. A developer creates a governed job from the CLI or `POST /v1/jobs` with an
   exact decimal-string budget.
2. Governor returns the job ID, pinned pricing identity, protected final
   reserve, and currently available work budget.
3. The agent sends each Responses request through
   `POST /v1/jobs/:jobId/responses`, with a job-scoped `request_id` and a
   `work` or `final` phase.
4. The runtime counts, reserves, caps, and dispatches against the same job
   ledger; valid terminal usage settles the reservation.
5. The developer retrieves a stored response with
   `GET /v1/jobs/:jobId/responses/:requestId` and inspects exact accounting
   with the CLI or `GET /v1/jobs/:jobId`.
6. A genuine post-dispatch ambiguity remains fully reserved and moves the job
   to `reconciliation_required`; no further request is safe until it is
   reconciled.
7. A completed final response moves to `validation_required`; the application
   explicitly accepts or rejects it before the job closes.
8. For a no-key demonstration, the CLI can play the separately labeled
   synthetic PR-review scenarios and the dashboard can visualize the same
   fixtures.

### 8.2 Request identity and retrieval

`request_id` is an idempotency key within one job. The service fingerprints the
canonical request context, phase, requested output cap, and admission floor.
Concurrent identical submissions share one provider dispatch; a later
identical `POST` replays the stored outcome. Reusing the ID for a different
intent returns `409 REQUEST_ID_CONFLICT`.

The response `GET` route returns `200` with the stored execution and current
job state, without dispatching again. If the original `POST` returned an
unresolved `202`, repeating that `POST` returns the same unresolved outcome and
the `GET` reports its unresolved execution. Neither is permission to retry.
The worst-case reservation remains committed until provider reconciliation.
The current HTTP and CLI surface has no reconciliation operation, so that job
remains locked in the running process.

### 8.3 Example visible state

```text
Task policy              Routine PR Review
Application ceiling      $0.75
Settled list-price cost  $0.31
Reserved next call       $0.18
Protected final reserve  $0.14
Risk band                AT_RISK
Forecast mode            SHADOW

Observed drivers
- Context grew from 18K to 49K input tokens
- Two equivalent test commands failed
- The latest test log contains 14K tokens

Deterministic action
- Kept exit code, failing tests, and relevant error lines
- Stored raw log outside model context under an artifact hash
- Rejected an unchanged retry
```

All dollar values in the current demo are synthetic list-price calculations
from fixture usage, not measured usage, invoice amounts, or savings.

### 8.4 Required states

- Ready
- Admitting request
- Running one response
- Settling usage
- Reconciliation required
- Final validation required
- Safe
- Watch
- At risk
- Applying deterministic control
- Shadow recommendation recorded
- Completed under policy
- Stopped because no safe request fits
- Failed for a non-budget reason
- Replay with permanent watermark
- Live

Replay and live data must never be visually ambiguous.

## 9. Technical Architecture

```text
Terminal CLI / HTTP client
            |
            v
Versioned governed-jobs API
            |
            v
Input preflight -> reservation ledger -> one Responses API call
            ^
            |
Built-in PR-review workflow <-> read-only local repository tools

Optional React dashboard -> synthetic demo API and fixtures
```

### 9.1 Components

**Governed jobs service**

- Creates and inspects in-memory ledgers.
- Submits, fingerprints, stores, and retrieves governed response outcomes.
- Requires explicit application validation of a completed final response.
- Does not run a tool loop or enforce equivalent-tool retry policy.

**Built-in PR-review orchestrator**

- Owns the fixed job phases.
- Allows only one model response in flight per job.
- Disables implicit retries.
- Executes schema-validated local tools.
- Keeps controller policy outside model context.

**Responses API adapter**

- Counts the exact proposed input through the input-token endpoint.
- Applies `max_output_tokens`.
- Disables parallel tool calls.
- Normalizes terminal usage and incomplete responses.

**Single-process reservation ledger**

- Calculates each request's maximum supported list-price charge.
- Reserves that amount before dispatch.
- Retains the full reservation after genuine post-dispatch ambiguity.
- Settles only when terminal usage is available.
- Is synchronous in-process memory in the POC; it has no restart durability or
  cross-process transaction boundary. Its reconciliation method is not exposed
  by the current HTTP or CLI surface.

**Usage and price calculator**

- Separates uncached input, cached input, cache-write input when applicable,
  output, and reasoning details.
- Avoids double-counting reasoning tokens already included in output.
- Pins model, service tier, region, rate-card version, and currency.

**Deterministic safety controller**

- Applies final-answer reserves, log reduction, duplicate references, retry
  limits, and stop rules.
- Works without any learned predictor.
- Never approves a budget extension.

**Shadow risk estimator**

- Emits `SAFE`, `WATCH`, or `AT_RISK`.
- May show an empirical range with its sample count.
- Cannot act until a preregistered experiment proves incremental value.

**Trace manifest**

- Includes every attempted run and exclusion.
- Records provider request IDs when available.
- Powers replay with an immutable `REPLAY` watermark.

**Independent evaluation runner**

- Cannot expose ground truth to the agent, controller, reducer, or predictor.
- Applies the success gate before showing any savings result.
- Compares all three controllers and intervention ablations.

## 10. OpenAI and Codex Integration

### 10.1 Recommended MVP: restricted Responses API loop

The Responses API is the feasible control surface because the application owns
the loop. The MVP should:

- Use three or four explicit phases.
- Use local custom functions for diff, file reads, search, and tests.
- Count each proposed request with `POST /v1/responses/input_tokens`.
- Set a conservative `max_output_tokens`.
- Set `parallel_tool_calls: false`.
- Exclude hosted and MCP tools.
- Permit one in-flight response.
- Disable automatic retries.
- Settle from terminal provider usage.

The API provides token controls, not a dollar budget. Governor translates
a pinned rate card into a conservative application-level list-price ceiling.

### 10.2 Codex boundary

Codex is useful for building the project and could later provide read-only
diagnosis of expensive workflow code. It should not be presented as the MVP's
hard-budget execution boundary unless its public interface exposes every
reservation and settlement control the controller needs.

Therefore:

- The Responses API owns the hackathon runtime.
- Codex can assist implementation or future diagnosis.
- The project must not claim visibility into or control over hidden paid work
  inside an opaque agent turn.

### 10.3 Track strategy

The stated track allows Codex and/or the OpenAI API. Build the real product on
the Responses API. Add Codex telemetry only after the core three-arm experiment
works. Do not bolt on Codex in a way that weakens cost enforcement.

### 10.4 Why a future live experiment needs the OpenAI API

The live evidence path would:

- Runs the actual model workflow.
- Preflights every model request.
- Applies output bounds.
- Reads terminal usage.
- Changes later context and tool output.
- Evaluates the completed model result.

The current repository implements this adapter contract but tests it with fake
transport. OpenAI is not yet inside the evidence loop.

## 11. Cost Accounting

### 11.1 Cost unit

Use integer microdollars or another fixed-point unit. Do not use binary
floating-point dollars for financial calculations.

```text
1 dollar = 1,000,000 microdollars
```

### 11.2 Per-step calculation

A normalized list-price calculation is:

```text
settled request cost =
    uncached input tokens * uncached input rate
  + cached input tokens * cached input rate
  + cache-write tokens * applicable cache-write rate
  + billable output tokens * output rate
```

Provider documentation determines whether reasoning tokens are already part of
the billable output total. Never add a reasoning-detail field a second time if
it is a subset of output tokens.

Hosted tools are excluded from the MVP. Their billing and control boundaries
would require separate reservation logic.

### 11.3 Versioned rates

Every recorded cost should include:

- Provider
- Model identifier
- Service tier
- Processing region
- Rate-card version
- Currency
- Timestamp
- Source of the rate

Pricing can change. Historical traces retain provider-reported usage and the
rate card used at the time. The UI must say "calculated list-price API cost,"
not "invoice cost" or "measured dollars."

### 11.4 What the MVP should count

Include:

- OpenAI uncached input
- OpenAI cached input
- OpenAI cache-write input when returned and applicable
- OpenAI output

Exclude but disclose:

- Hosted OpenAI tools
- Developer laptop compute
- Local test execution
- Database and hosting cost
- Employee time
- Taxes, negotiated discounts, and invoice-level adjustments

Pin one model, service tier, region, and direct API-key path for the entire
benchmark.

### 11.5 Budget semantics

The task-class policy contains:

- `applicationCeiling`: Maximum calculated list-price cost for the job.
- `finalAnswerReserve`: Amount protected for completion or handoff.
- `minimumFinalOutputTokens`: Admission floor protected for a final response.
- `maxResponses`: Maximum number of model responses.
- `maxEquivalentRetries`: Equivalent-tool retry limit for the built-in
  PR-review workflow.
- `rateCardVersion`: Rates used for every admission decision.

The PR-review workflow receives this policy by task class. The generic
`POST /v1/jobs` API instead accepts a caller-supplied budget and selected policy
fields. It does not expose `maxEquivalentRetries` because
`POST /v1/jobs/:jobId/responses` cannot classify equivalent workflow retries.

### 11.6 Request reservation

Before every response:

1. Count the exact proposed input with the input-token endpoint.
2. Price the input using the most conservative applicable rate.
3. Subtract the protected final-answer reserve when the response is not final.
4. Convert the safe remainder into `max_output_tokens`.
5. Calculate the request's worst supported list-price charge.
6. Atomically reserve that amount.
7. Dispatch only after the reservation succeeds.

```text
available =
  application ceiling
  - settled job cost
  - existing reservations
  - required future reserve

maximum output tokens =
  floor((available - known input ceiling) / output token rate)
```

`minimum_output_tokens` is an admission capacity floor, not a generation
length guarantee. If the budget-adjusted output cap is below the floor, the
request is denied before dispatch. Otherwise, only `max_output_tokens` is sent
to the provider, which may generate fewer tokens.

Only one response may be in flight. After dispatch, a transport, protocol, or
usage ambiguity keeps the full reservation and requires provider
reconciliation. Repeating the same `request_id` only returns the stored
unresolved outcome; it never redispatches. Automatic network retries are
disabled.

This is an application-level ceiling under pinned public pricing. It is not a
claim that Governor controls the provider invoice.

## 12. Event and Data Model

The following interfaces are conceptual. Names can change during
implementation, but the information boundaries should remain.

```typescript
type Money = {
  currency: "USD";
  microdollars: number;
};

type NormalizedUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens?: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  usageSource: "provider";
};

type RequestReservation = {
  requestId: string;
  inputTokens: number;
  maxOutputTokens: number;
  reservedCost: Money;
  rateCardVersion: string;
  status: "reserved" | "settled" | "ambiguous" | "released";
};

type StepEvent = {
  jobId: string;
  stepId: string;
  sequence: number;
  model: string;
  startedAt: string;
  completedAt: string;
  reservation: RequestReservation;
  usage: NormalizedUsage;
  settledListPriceCost: Money;
  cumulativeSettledCost: Money;
  contextTokens: number;
  toolCalls: Array<{
    name: string;
    argumentHash: string;
    status: "completed" | "failed";
    outputBytes: number;
    repeated: boolean;
  }>;
};

type RiskEstimate = {
  jobId: string;
  afterStep: number;
  band: "safe" | "watch" | "at_risk";
  empiricalRange?: {
    low: Money;
    high: Money;
    sampleCount: number;
  };
  confidence: "low" | "medium" | "high";
  outOfDistribution: boolean;
  mode: "shadow" | "active";
  evaluatedPolicy: "static" | "predictive";
  drivers: Array<{
    label: string;
    direction: "increases_cost" | "decreases_cost";
    evidence: string;
  }>;
  predictorVersion: string;
};

type PolicyDecision = {
  jobId: string;
  afterStep: number;
  action:
    | "continue"
    | "reduce_tool_output"
    | "suppress_duplicate_output"
    | "limit_retry"
    | "cap_next_response"
    | "stop";
  reason: string;
  estimatedQualityRisk: "low" | "medium" | "high";
  source: "safety" | "static" | "predictive";
  executed: boolean;
};
```

### 12.1 Trace integrity

Each final result should be reproducible from:

- Input task identifier
- Task-class policy
- Repository fixture version
- Agent and prompt version
- Provider model, tier, and region
- Rate-card version
- Input-token preflights and reservations
- Ordered step events
- Ordered shadow recommendations
- Ordered policy decisions
- Final output
- Evaluation version and result
- Provider request IDs when available
- Run-manifest inclusion or exclusion reason

A replay must show a permanent `REPLAY` watermark, trace ID, capture time, and
manifest hash. It must never silently replace a failed live run.

## 13. Risk Estimation and Shadow Forecasting

### 13.1 Core rule

The deterministic controller is the product's safe core. A learned predictor
is an experiment, not a dependency. It begins in shadow mode and cannot alter
execution.

Do not display calibrated-looking percentages or P90 claims from the hackathon
dataset. Display a risk band and, when useful, an empirical range with the
number of independent historical tasks supporting it.

### 13.2 Policy-specific target

"Final job cost" depends on the policy controlling the job. A baseline trace
does not directly reveal what would have happened after a different
intervention, and a stopped job censors the cost of hypothetical completion.

Every estimate must name the policy it evaluates:

```text
estimated remaining cost if the frozen static policy continues
```

Evaluate an estimate at the last actionable checkpoint before an intervention.
Do not score terminal rows where current spend almost equals final spend.

### 13.3 Fixed features

Known before execution:

- Task category
- Number of changed files
- Diff line count
- Repository size bucket
- Programming language
- Initial context tokens
- Task-class policy
- Model and reasoning setting
- Tool set available
- Agent, prompt, and policy versions

### 13.4 Dynamic features

Updated after each step:

- Cumulative settled list-price cost
- Outstanding reservation
- Step count
- Current context tokens
- Context growth since the prior step
- Average context growth rate
- Input, cached input, output, and reasoning tokens
- Number of tool calls
- Failed tool calls
- Retry count
- Repeated tool argument hashes
- Repeated output hashes
- File reads and unique files read
- Test commands run
- Remaining wall-clock time
- Whether an intervention already occurred

Avoid feeding raw source code or prompt text into the first predictor. Numeric
and categorical metadata is easier to secure, explain, and train with limited
data.

### 13.5 Data split and leakage controls

Rows from one job are correlated. Split by:

- Entire task
- Bug or task-template family
- Repository module

Also:

- Assign task policies before observing holdout costs.
- Exclude terminal and post-outcome rows.
- Prevent hashes and IDs from becoming task fingerprints.
- Weight by job so long traces do not dominate.
- Keep benchmark ground truth unavailable until final output is sealed.

### 13.6 Estimation ladder

**Version 0: deterministic bound**

- Exact proposed input count
- Worst permitted output
- Remaining response count
- Final-answer reserve
- Static retry and context thresholds

This powers safety and requires no training data.

**Version 1: heuristic risk band**

- `SAFE`: Static plan and reserve fit comfortably.
- `WATCH`: Cost or context growth exceeds a validation threshold.
- `AT_RISK`: No static completion path fits without reducing work.

This is the recommended POC.

**Version 2: shadow empirical forecast**

- Compare current state with independent historical tasks.
- Report a range and sample count.
- Record whether it would change the static decision.
- Do not activate it during initial data collection.

**Version 3: promoted predictor**

Promote only after a frozen comparison shows incremental value. A hackathon
does not need this version.

### 13.7 Decisive comparison

Freeze two otherwise identical controllers:

- **Static controller:** Reservation, reserve, retry limits, output reduction,
  duplicate references, and fixed thresholds.
- **Predictive controller:** The same controls, with the forecast as the only
  additional decision input.

Run both in shadow until their first decision disagreement. Evaluate
continuations from the same recorded prefix in randomized order. Compare:

- Task success under the frozen rubric
- Total cost across assigned tasks
- Cost at the first actionable checkpoint
- How often the controllers disagree
- Critical misses introduced by prediction
- Whether gains remain after static hygiene is enabled

Prediction fails its gate if the controllers rarely disagree, cost does not
improve at the same observed success level, or prediction introduces any
additional critical miss.

### 13.8 Distribution shift and explanations

Model, prompt, tool, repository, and policy changes invalidate historical
comparability. Version all of them. Out-of-distribution jobs remain under the
deterministic controller.

Safe explanation:

> "Risk moved to AT_RISK after context grew 2.8x and two equivalent tool calls
> failed."

Unsafe causal claim:

> "These features causally created exactly $0.37 of future cost."

Observed drivers explain the risk decision; they do not establish causation.
This is also the practical lesson from work distinguishing decodable signals
from causally used representations: a feature can be easy to recover without
being the mechanism that drives behavior. That paper can inform ablations and
intervention design, but it does not validate Governor's risk model.

## 14. Governor Policy

### 14.1 Safety loop

```text
Construct next request
    |
    v
Count input and calculate worst-case charge
    |
    v
Reserve atomically and set output cap
    |
    +--> Does not fit: reduce work or stop
    |
    v
Run one response and local tools
    |
    v
Settle usage and record shadow risk
```

### 14.2 Example policy

```text
if an_unreconciled_request_exists:
    stop

if duplicate_tool_output_is_large:
    suppress_duplicate_output
else if equivalent_retry_count >= retry_limit:
    limit_retry

input_tokens = count_input(proposed_request)
max_output_tokens = calculate_safe_output_allowance(
    input_tokens,
    settled_cost,
    outstanding_reservations,
    final_answer_reserve,
    application_ceiling
)

if max_output_tokens < minimum_useful_output:
    reduce_tool_output_or_stop

reserve_request_ceiling()
run_one_response(max_output_tokens, parallel_tool_calls=false)
settle_from_terminal_usage()
record_shadow_risk_estimate()
```

The model cannot change the policy, rate card, reserve, or budget. Only an
authenticated human or pre-authorized team envelope may extend authority; the
demo does not require an interactive approval for routine pennies.

### 14.3 Predictive promotion

A shadow predictor may become active only when a frozen holdout shows:

- Decision disagreement with the static controller
- Lower total cost at the same observed task-success gate
- No additional critical miss
- Stable benefit across task families
- No reliance on terminal-state predictions

## 15. Intervention Catalog

### 15.1 Deterministic long-output reduction

Large test logs are the recommended first intervention. Store the complete raw
artifact outside model context and return a deterministic extract:

- Exit code
- Failing test names
- Error class and error lines
- Fixed-size surrounding excerpts
- Truncation disclosure
- Artifact hash

The reducer must not know the hidden benchmark rubric. The agent may request a
specific omitted range, subject to the next request's admission check.

### 15.2 Duplicate observation references

If the agent requests the same immutable content again, do not resend the full
payload. Return a short reference:

```text
Unchanged from observation obs_17.
SHA-256: ...
Relevant lines: ...
```

The cache key should include:

- Tool name
- Canonical arguments
- File or repository revision
- Requested range
- Content hash

Never reuse a result after the underlying file or repository state changes.

### 15.3 Retry limiting

Identify semantically equivalent attempts using canonical tool names,
arguments, and error classes.

After the retry budget is consumed:

- Require a materially different plan.
- Return the prior failure summary.
- Stop if no safe alternative fits.

Do not block legitimate retries after a changed file, changed dependency, or
transient infrastructure error.

### 15.4 Pinned stateless state

Construct future requests from application-owned fields:

- Original objective
- Non-negotiable policy and output schema
- Current diff
- Model-produced candidate findings, clearly marked untrusted
- Tool evidence and artifact references
- Open questions

Repository and model text must never be promoted into trusted policy. Keep the
hidden evaluation rubric entirely outside this state.

### 15.5 Next-response cap and final reserve

Set a conservative maximum for the next model response based on:

- Exact preflight input count
- Worst applicable input and output rates
- Outstanding reservations
- Protected final-answer reserve
- Minimum useful output for the current phase

If the response ends incomplete, treat that as a normal controlled outcome and
use the reserve for a bounded final handoff only when it fits.

### 15.6 Native OpenAI compaction

Native compaction is useful for long-running workflows, but its encrypted
compaction item is opaque and the returned canonical window must be passed
forward as-is. Governor therefore cannot inspect it to prove that every
critical fact survived.

Do not use native compaction as the primary hackathon intervention or quality
claim. Evaluate it later as a separately versioned policy.

### 15.7 Stop

Stop when:

- Another request remains unresolved.
- The next request ceiling cannot fit.
- The job is stuck in a repeated failure loop.
- Required context was lost.
- Terminal provider usage is unavailable and the reservation cannot settle.

Return a useful partial result and a clear reason whenever possible.

### 15.8 Interventions to defer

**Model switching**

Switching to a cheaper model is visually compelling but complicates the claim
that quality stayed constant. Defer it until the same-model controls work.

**Opaque native compaction**

It may save context, but its contents are not human-inspectable. It cannot
support the first demo's explicit state-preservation proof.

**Automatic source-code patching**

This changes the product into a source-code optimization agent and distracts
from runtime governance. It is not required.

**Prompt rewriting**

Prompt rewriting can change behavior in difficult-to-measure ways. Keep the
original task and policy instructions pinned.

## 16. Quality and Evaluation

Saving tokens is not enough. An agent that stops early is cheap but useless.

### 16.1 Primary metric

Do not collapse cost and quality into one ratio. A controller can make that
ratio look better by stopping difficult jobs or changing which jobs complete.
Use this fixed decision order:

1. Apply the quality gate to every assigned holdout job, including stopped and
   invalid jobs.
2. Reject any controller that adds a critical miss or falls below the
   precommitted task-success threshold.
3. Among controllers that pass, compare total calculated list-price API cost
   across all assigned jobs.
4. Report successful completions and policy stops separately.

Quality is the constraint. Cost is optimized only among systems that satisfy
it.

### 16.2 Secondary metrics

- Assigned-job task-success rate
- Critical issue recall and clean-task precision
- Total calculated list-price API cost
- Mean and median cost across all assigned jobs
- Completed-under-policy rate
- Quality delta across all three controllers
- Intervention rate
- Unnecessary-intervention rate
- Forecast false-safe rate
- Policy-stop and non-budget failure rates
- Completion latency

### 16.3 Pull-request review quality rubric

Create pull requests with seeded ground-truth issues. Require structured output
containing:

- Finding category
- Severity
- File
- Line or code region
- Explanation
- Suggested mitigation

Score deterministically where possible:

- Critical issue recall
- Overall seeded issue recall
- False positives
- Correct file attribution
- Correct severity bucket

Include clean pull requests with no seeded bugs. Otherwise an agent can score
well by always inventing a finding.

### 16.4 Success definition

Define success before collecting results. One example:

- Finds every critical seeded issue.
- Finds at least a fixed fraction of all seeded issues.
- Produces no critical false positive.
- Returns valid structured output.

Do not change the rubric after seeing governed results.

### 16.5 Three-arm evaluation

Run the same held-out tasks under three frozen policies:

- **Hard cap:** Request admission and stop rule, without context optimization.
- **Static controller:** The hard cap plus fixed log reduction, duplicate
  references, retry limits, and final-answer reserve.
- **Predictive controller:** The identical static controller with the shadow
  risk estimate as its only additional decision signal.

The third arm is not allowed to act during initial data collection. For
decision disagreements, replay continuations from the same saved prefix in
randomized order. This isolates the predictor's incremental value from basic
engineering hygiene.

Because model outputs are stochastic, one paired run is not strong evidence.
Use repeated runs when time and cost allow. At minimum, disclose the number of
tasks and repetitions.

### 16.6 Avoid evaluation leakage

- Hide seeded issue labels from the agent.
- Keep holdout pull requests out of predictor training.
- Do not tune intervention thresholds on the final holdout.
- Version prompts and tools.
- Keep the quality evaluator independent from Governor's forecast.
- Prefer deterministic ground truth over an LLM grading its own work.

## 17. Hackathon Dataset

### 17.1 Recommended benchmark

Create 15 to 20 small pull requests in one fixture repository:

- Input-validation bugs
- Authorization mistakes
- Error-handling regressions
- Incorrect edge-case logic
- Resource or retry mistakes
- Clean control pull requests

Vary:

- Number of changed files
- Diff size
- Amount of surrounding context needed
- Test-log size
- Number of plausible but irrelevant files

Run each task two or three times if budget permits, producing roughly 40 to 60
real traces.

### 17.2 Required trace fields

- Task and fixture version
- Model and prompt version
- Tool definitions
- Every model usage record
- Every tool call and status
- Context size estimate
- Every forecast
- Every policy action
- Final measured cost
- Final quality result

### 17.3 Training split

Split by pull request:

- Training tasks
- Validation tasks
- Final hidden holdout tasks

Never place different runs or steps from the same pull request on both sides of
the split.

### 17.4 Synthetic versus real

The repository and bugs may be synthetic. The model calls, usage records, cost
calculation, and evaluation execution should be real.

Use this precise description:

> "We evaluated real OpenAI agent runs on a synthetic pull-request benchmark."

Do not describe the benchmark as customer data.

## 18. Validate Before Building the Full Product

The adversarial design review and deterministic technical POC are complete.
They found no fatal single-process enforcement blocker, but the POC did not
make live OpenAI calls or validate savings. The next step is a real,
outcome-gated experiment, not broader dashboard work.

### 18.1 Thirty-to-forty-five-minute adversarial gate

Ask reviewers or agents to attack only the fatal assumptions:

1. Can usage be measured at a useful step boundary?
2. Can one response exceed the remaining budget before control returns?
3. Is the proposed intervention technically supported?
4. Can quality be measured independently?
5. Is the demo distinct from a token counter or hard cap?
6. Is enough variation available to demonstrate forecasting?

Do not spend hours generating broad product criticism before testing the API.

### 18.2 Implemented technical POC

The repository now includes:

1. One multi-step pull-request review.
2. Exact input-token preflight and worst-case reservation before every request.
3. Terminal usage settlement and fixed-point cost calculation.
4. One deterministic test-log reducer that stores the raw artifact.
5. A hard cap and a static controller.
6. One heuristic risk band recorded in shadow mode.
7. The same sealed deterministic quality check for every run.
8. Canonical context/request hashes and provider/model/tier/region/rate-card
   binding.
9. Explicit final-output validation and trusted-snapshot retry suppression.

The multi-step path and accounting invariants pass against a scripted fake
provider. This is technical mechanism evidence, not live-provider,
durability, benchmark, or savings evidence.

### 18.3 Remaining experimental gate

Before making a measured performance or savings claim, confirm with live,
previously unseen tasks that:

- Every proposed request can be counted and admitted before dispatch.
- Every completed response produces usable terminal usage data.
- The job has at least three meaningful control points.
- Worst-case reservation prevents a second request from crossing the
  application ceiling under the pinned rate card.
- The log reducer materially shrinks the next request while retaining the
  evidence required by the predefined quality check.
- At least some tasks create a meaningful decision difference between a hard
  cap and the static controller.
- The run completes in a demo-friendly amount of time.

If these do not hold, change the workload or intervention before promoting the
scripted dashboard as experimental evidence. A forecast is not required for
the technical POC to pass.

## 19. Dashboard Design

The application should be a quiet operational interface, not a marketing
landing page.

### 19.1 First viewport

**Top status strip**

- Task
- Automatically assigned task policy
- Application ceiling
- Settled cost
- Outstanding reservation
- Protected final-answer reserve
- Risk band and `SHADOW` or `ACTIVE` mode
- Job state

**Main timeline**

- Model steps
- Tool calls
- Cost increments
- Forecast changes
- Intervention marker

**Explanation panel**

- Observed risk drivers
- Deterministic action and reason
- Shadow recommendation, when it differs
- Expected quality tradeoff

### 19.2 Result view

Display all three frozen policies side by side:

| Metric | Hard cap | Static | Predictive |
| --- | ---: | ---: | ---: |
| Quality gate | Pass/fail | Pass/fail | Pass/fail |
| Critical misses | Count | Count | Count |
| Successful jobs | Count | Count | Count |
| Total calculated API cost | Value | Value | Value |
| Policy stops | Count | Count | Count |
| Interventions | Count | Count | Count |

When prediction remains in shadow mode, label its column `SHADOW RESULT`; do
not imply that it controlled a live job.

### 19.3 Visual rules

- Use one consistent dollar scale.
- Show uncertainty as a range, not fake precision.
- Keep the budget line visible on the cost chart.
- Mark interventions directly on the timeline.
- Use red for actual risk, not decoration.
- Label measured, estimated, synthetic, and replayed values.
- Do not hide a quality decrease behind a large savings number.
- Keep controls stable so changing values do not shift the layout.

## 20. Ninety-Second Demo

### 0-15 seconds: establish the problem

> "This pull-request review automatically receives our Routine Review cost
> policy. A hard cap can stop an expensive agent, but it cannot preserve a path
> to a useful answer."

Start the scripted governed-review simulation and state that no model call is
occurring.

### 15-35 seconds: show the risk change

The agent reads the diff, searches the repository, and runs tests.

> "Governor counted and reserved each request before it ran. After this
> large test result, the risk band moved to AT_RISK because context grew and
> the same failing test path is being retried."

### 35-55 seconds: show the intervention

> "Instead of forwarding the full log, it keeps the exit code, failing tests,
> relevant error lines, and a hash of the raw artifact. It blocks an unchanged
> retry and protects the final-answer reserve."

Show the timeline marker and reduced context.

### 55-75 seconds: show completion and quality

> "The sealed benchmark passes. Only now do we compare cost."

### 75-90 seconds: show the comparison

> "Here are the hard cap, static controller, and predictive shadow result. The
> useful question is whether prediction improves on strong fixed controls, not
> whether it beats an intentionally weak baseline."

For the current demo, describe every dollar value as synthetic. Use measured
language only after a separately labeled live benchmark exists.

## 21. Demo Reliability and Truth Boundary

### Implemented scripted path

- Replays deterministic synthetic scenarios generated in-process.
- Uses synthetic usage, timing, receipts, quality outcomes, and calculated
  list-price costs.
- Makes no external model or provider API call.
- Is permanently labeled as demo/scripted data.

### Future live path

- Would run the restricted OpenAI adapter and stream actual model/tool events.
- Would settle provider-reported usage under the pinned rate card.
- Must keep measured live data distinct from scripted fixtures.
- Is not implemented or evidenced by the current dashboard.

### Recommended judging strategy

- Use the labeled scripted run and synthetic comparison.
- Do not describe it as live, captured, measured, or savings evidence.
- Add a live run only after the adapter is exercised and the UI can keep it
  visibly distinct from scripted replay.
- Keep screenshots of the at-risk, intervention, and result states.

## 22. Two-Engineer Scope

### Engineer A: Runtime and control

- Responses API agent loop
- Allowlisted repository tools
- Input-token preflight and atomic reservation
- Usage normalization
- Price calculator
- Forecast adapter
- Policy engine
- Deterministic log and retry controls

### Engineer B: Benchmark and experience

- Seeded pull-request fixture
- Deterministic quality evaluator
- Trace collection scripts
- Three-arm analysis
- Dashboard and timeline
- Replay mode and demo choreography

### Shared work

- Lock the job and quality definition.
- Run the first POC together.
- Review every user-facing claim.
- Rehearse the demo against failure cases.

## 23. Suggested 24-to-36-Hour Build Order

### Hours 0-1: adversarial gate

- Review the completed adversarial findings.
- Lock the job boundary, policy, and quality rubric.
- Select deterministic test-log reduction.
- Confirm POC pass and kill criteria.

### Hours 1-4: technical spike

- Run one multi-step review.
- Count the exact proposed request before dispatch.
- Prove worst-case reservation and output caps.
- Capture provider usage.
- Calculate fixed-point list-price cost.
- Prove the reducer changes the next request.

### Hours 4-10: traceable agent

- Add allowlisted tools.
- Persist normalized step events.
- Add context, retry, and output-size features.
- Produce a structured final review.

### Hours 10-16: benchmark and forecast

- Create initial seeded tasks.
- Record hard-cap and static-controller traces.
- Implement heuristic risk bands in shadow mode.
- Record where shadow and static decisions disagree.

### Hours 16-22: policy and intervention

- Implement risk thresholds.
- Add deterministic log reduction and duplicate references.
- Reserve final-answer budget.
- Add admission failure and stop behavior.

### Hours 22-28: evaluation and dashboard

- Run the three frozen policies on holdout tasks.
- Apply the quality gate before comparing total cost.
- Build the timeline and three-arm comparison.
- Add measured versus estimated labels.

### Hours 28-36: reliability and pitch

- Add replay.
- Handle provider and tool failures.
- Verify desktop and mobile layout.
- Freeze measured results.
- Rehearse the ninety-second demo.

## 24. Must, Should, and Cut

### Must have

- One real multi-step agent workflow
- Input preflight, worst-case reservation, and terminal usage settlement
- Versioned fixed-point cost calculation
- One deterministic intervention
- One in-flight response with an explicit output cap
- Independent quality evaluation
- Hard-cap versus static-controller comparison
- Shadow risk band and disagreement logging
- Clear live/replay labels

### Should have

- Three-arm continuation replay from the same prefix
- Empirical cost range with sample count
- Observed risk drivers
- Trace replay
- Predictor ablation by task family

### Cut first

- Ramp API integration
- Multiple providers
- Model switching
- Automatic code patches
- Organization and team dashboards
- Complex authentication
- General policy builder
- Multicalibration
- Native opaque compaction
- Codex runtime adapter
- Long-term savings projections

## 25. Security and Privacy

### 25.1 API keys

- Keep provider credentials on the server.
- Never include keys in browser state, traces, or replay files.
- Use narrowly scoped project credentials.
- Rotate any credential exposed during development.

### 25.2 Source-code privacy

Traces can contain proprietary code and tool output.

- Store hashes and numeric features when raw content is unnecessary.
- Redact secrets before model and trace ingestion.
- Encrypt stored raw traces in production.
- Define retention and deletion.
- Do not send raw traces to Ramp or another system by default.

### 25.3 Tool execution

- Use an isolated fixture repository.
- Allowlist commands.
- Disable or restrict network access.
- Apply time and output limits.
- Treat repository content and tool output as untrusted.
- Do not let model text modify the governor's budget policy.

### 25.4 Prompt injection

Repository files may contain instructions such as "ignore your budget."

- Keep budget policy outside model context where possible.
- Treat file text as data.
- Never let model output authorize more spend.
- Permit budget changes only through authenticated team policy.
- Disable budget extensions entirely in the hackathon workflow.

### 25.5 Controller integrity

The forecast may be learned, but enforcement must be deterministic:

- The model cannot alter measured usage.
- The model cannot alter the rate card.
- The model cannot mark its own task as successful.
- The model cannot increase its hard budget.
- The model cannot hide failed steps from the trace.

### 25.6 Production multi-tenancy

Out of scope for the hackathon, but a production system needs:

- Tenant isolation
- Role-based budget control
- Per-project credentials
- Durable audit records
- Idempotent job operations
- Rate limiting
- Data residency controls
- Configurable retention

## 26. Reliability and Failure Handling

### Post-dispatch ambiguity

- Mark the request ambiguous.
- Record any usage returned.
- Retain its full reservation.
- Set the job to `reconciliation_required` and do not retry.
- Reconcile against provider evidence before releasing or settling it. The
  current public API does not expose this operation.

### Missing usage

- Do not settle or display the request as measured cost.
- Keep the worst-case reservation charged against the job.
- Require reconciliation and block further admission.

### Tool failure

- Normalize the error.
- Detect identical retries.
- Preserve relevant error details without resending full output.

### Log-reducer failure

- Keep the complete raw artifact outside model context.
- Do not substitute an unvalidated summary.
- Retry the deterministic reducer once without another model call.
- Stop if the unreduced next request cannot pass admission.

### Invalid final output

- Count the job as unsuccessful.
- Do not hide the failure because it was cheap.
- Use the remaining reserve for at most one schema-repair attempt.

### User cancellation

- Abort the active request if supported.
- Record cancellation separately from policy stop.
- Report measured cost already incurred.

## 27. Adversarial Review

| Attack | Why it is valid | Product response |
| --- | --- | --- |
| "This is just a token counter." | Counting one prompt is useful but not job-level control. | Show preflight, reservation, settlement, a changed next request, and a policy stop. |
| "Why not set `max_output_tokens`?" | That caps one response, not all future steps, tools, and retries. | Use per-response caps as one enforcement mechanism inside a job-level governor. |
| "Why not use a built-in budget?" | A hard stop is valuable but may strand the task. | Compare it directly with a controller that preserves final-answer capacity and reduces expensive observations. |
| "The predictor cannot know what the agent will do." | It cannot know exactly. | Use risk bands, keep it shadow-only, and promote it only if it beats the same controller without prediction. |
| "Your model only memorized the benchmark." | Small correlated datasets can leak. | Split by task, hold out entire pull requests, and compare against a simple baseline. |
| "Reducing a log can hide the bug." | Any information removal can lower quality. | Use a deterministic extractor, retain the raw artifact, permit bounded range retrieval, and evaluate sealed outcomes. |
| "The agent can spend the budget in one call." | Exact usage returns after completion. | Count input, reserve the maximum supported charge, and set `max_output_tokens` before dispatch. |
| "The savings come from stopping early." | A failed task is cheaper. | Score every assigned job first; compare cost only after the controller passes the quality gate. |
| "Your synthetic tasks prove nothing." | They do not prove production impact. | Say the current data are scripted fixtures and run a separate live holdout before making performance or savings claims. |
| "The agent will game the budget." | Optimization pressure can cause shortcuts. | Keep success evaluation external and independent. |
| "Pricing changes." | Dollar forecasts drift. | Store raw usage and versioned rate cards. |
| "Caching makes cost confusing." | Cached input may use a different rate. | Track cached and uncached input separately. |
| "This is a dashboard with an animation." | A passive UI has no control value. | Show the actual next request changed and compare governed execution. |
| "One workflow is too narrow." | The demo is not universal. | Treat narrowness as honest validation and show an adapter-based roadmap. |

## 28. Competitive Differentiation

| Product type | What it does | What Governor adds |
| --- | --- | --- |
| Token counter | Estimates prompt or response size | Admits and settles every request inside a job policy |
| Cost dashboard | Reports historical usage | Changes future execution before the next paid call |
| Hard budget | Stops at a limit | Reserves a completion path and reduces bounded work |
| Prompt optimizer | Shortens a prompt | Controls context, retries, and execution over time |
| Model router | Selects a model | Governs a full workflow and verifies task success |
| Observability platform | Traces model and tool calls | Converts traces into real-time policy decisions |

The concise contrast is:

> Dashboards explain yesterday. Hard caps stop today. Governor steers the
> job before it fails.

## 29. Ramp Relevance

Ramp transaction data can identify vendors, cards, owners, teams, and spending
trends. It generally cannot reveal which model request, retry, or tool result
caused a particular AI workflow to become expensive. Governor therefore
needs application telemetry from the workflow itself.

A credible discovery path is:

1. Use Ramp spend data to identify a team with material and growing AI vendor
   spend.
2. Ask that team to instrument one centrally owned, high-volume workflow.
3. Join sanitized Governor job summaries to the team, application, and
   vendor already visible in finance data.
4. Let finance define the envelope while engineering owns task policy and
   quality.

The hackathon does not need a live Ramp integration. A future connector should
send only task class, team attribution, calculated cost, policy result, and
trace identifier. Prompts, source code, test logs, and secrets stay out.

The strategic story is:

> Ramp finds where AI money is going. Governor gives the workflow that
> creates that spend a preventative control loop.

## 30. Judge Questions

### Is this just a maximum-token setting?

No. A maximum-token setting controls one response. An AI job may contain many
responses, tools, retries, and growing context. Governor admits each
request against a job-level policy, settles actual usage, protects final-answer
capacity, and changes later execution.

### How can you know the final cost?

We do not know it exactly before completion. The safety layer does not need to:
it reserves a conservative maximum for the next request. The optimization
layer shows `SAFE`, `WATCH`, or `AT_RISK` and remains in shadow mode until a
holdout proves that it improves decisions.

### What exactly does the product change?

The MVP deterministically reduces large test logs, references unchanged
observations, limits equivalent retries, protects a final-answer reserve, and
caps the next response.

### How do you know it did not make the agent worse?

The final review is scored by a sealed deterministic benchmark. A controller
must pass the precommitted quality gate across every assigned job before its
cost is compared.

### Is the data real?

No. The pull requests, model events, usage, timing, receipts, quality outcomes,
and calculated list-price costs shown by the dashboard are deterministic
scripted fixtures. The adapter and workflow are tested with a fake provider;
no live OpenAI run or measured savings result exists.

### Why use AI at all?

The governed interface is an AI-agent response loop, including tool calls and
growing context. The POC proves deterministic control against a fake provider;
a live experiment must still show that the same controls work with real API
usage.

### Why not govern every workload?

Different workflows have different completion patterns and quality metrics.
The hackathon version validates one workflow honestly. Production would add
versioned adapters and predictors for additional job types.

### What if the forecast is wrong?

Nothing changes while it is in shadow mode. If it fails the frozen comparison,
the system remains deterministic budget middleware and the predictive claim is
cut.

### What is technically difficult?

The difficult part is enforcing a dollar-denominated application policy when
exact usage arrives only after a response, then proving that adaptive control
adds value beyond strong fixed rules without harming task outcomes.

## 31. Claims and Language Guide

### Safe language

- "Scripted provider-usage fixture"
- "Synthetic calculated list-price cost"
- "In our deterministic pull-request simulation"
- "Shadow risk band"
- "Scripted quality-gate result"
- "The predictor did not change execution"

### Unsafe language

- "Guaranteed savings"
- "Perfect cost prediction"
- "No quality loss" without naming the evaluation
- "Production-ready"
- "Works for every AI agent"
- "Causally explains every token"
- "Real customer savings" when using fixtures
- "Calibrated overrun probability" without sufficient independent data
- "Invoice cost" when using a public rate card

### Recommended final result template

Use only after the benchmark runs:

> "Across [N] assigned synthetic pull-request tasks with real OpenAI calls,
> [controller] passed our precommitted quality gate and used [X%] less
> calculated list-price API cost than [comparison]. The predictive result was
> [shadow/active], and these results do not establish production savings."

## 32. Success and Kill Criteria

### Product success

- A viewer understands the problem in under 15 seconds.
- The agent has at least three observable control points.
- Every request is preflighted, reserved, and settled or left conservatively
  reserved.
- The static controller creates a visible execution difference from a hard
  cap on multiple tasks.
- All compared controllers meet the predefined holdout quality gate.
- The predictive controller disagrees with the static controller often enough
  to evaluate and lowers total cost without an additional critical miss.
- The scripted demo completes in under two minutes.
- Every amount is labeled measured, estimated, or synthetic as applicable.
- The audience can see exactly what intervention changed.

### Kill or pivot criteria

Pivot to a simpler hard-budget controller if:

- Usage cannot be observed at useful boundaries.
- Exact input preflight or conservative request reservation is unavailable.
- The predictor does not improve on the frozen static controller.
- The static intervention does not materially change future input or
  completion behavior.
- Quality decreases on the hidden holdout.
- One uncontrolled response routinely crosses the job budget.
- The demo takes too long or varies too much.
- The only savings come from stopping unsuccessful jobs.

Failing a kill criterion is useful information. It should happen during the
POC, not after the dashboard is polished.

## 33. Production Roadmap

### Phase 1: validated single workflow

- Pull-request review adapter
- Automatic task-class policies
- Request reservation and settlement
- Static log and retry controls
- Shadow risk bands
- Quality and cost receipt

### Phase 2: reusable SDK

- Provider-neutral job and step events
- Policy configuration
- More workflow adapters
- Model and prompt version tracking
- Durable trace storage
- Team-level dashboards

### Phase 3: financial control plane

- Ramp usage export
- Budget policies by team and application
- Approval workflows
- Realized savings measurement
- Forecast drift alerts
- Chargeback and cost allocation

### Phase 4: optimization marketplace

- Workflow-specific intervention plugins
- Safe model routing
- Organization-specific quality gates
- Automated policy experiments with holdouts

## 34. Decisions to Lock Before Coding

1. The only hackathon workflow is pull-request review.
2. A job is one complete structured review.
3. The primary implementation uses the Responses API.
4. The loop permits one in-flight response and no automatic retries.
5. Hosted tools, MCP, and parallel tool calls are excluded.
6. The first intervention is deterministic test-log reduction.
7. Native opaque compaction is not the primary intervention.
8. The first predictor emits risk bands in shadow mode.
9. The comparison is hard cap versus static versus predictive.
10. Quality is a gate defined before any cost comparison.
11. Task policies are assigned automatically, not entered per request.
12. Model switching and automatic code patches are out of scope.
13. Ramp integration and a Codex adapter come only after the core experiment.
14. Replay is permanently labeled and currently uses deterministic scripted
    fixtures, not captured real runs.
15. Current dollar values are synthetic calculations from fixture usage and a
    versioned rate card.

## 35. Build Checklist

### Validation

- [x] Define one job boundary and automatic policy.
- [x] Define the scripted quality rubric.
- [x] Run the adversarial design review.
- [x] Complete the fake-provider technical POC.
- [ ] Confirm the experimental pass criteria with live provider runs.

### Runtime

- [x] Build the multi-step agent loop.
- [x] Add bounded local tools.
- [x] Count proposed input before every request.
- [x] Reserve worst-case request cost in the in-memory ledger.
- [x] Settle scripted provider usage after terminal responses.
- [x] Calculate fixed-point cost.
- [x] Reserve final-answer budget and explicitly validate final output.
- [x] Bind context/request hashes and pricing identity.
- [ ] Add durable transactional storage and cross-process recovery.
- [ ] Exercise cancellation and timeout reconciliation with a live provider.

### Prediction

- [x] Build the deterministic heuristic baseline.
- [x] Record deterministic scripted traces.
- [x] Emit `SAFE`, `WATCH`, or `AT_RISK` shadow bands in the scripted demo.
- [ ] Extract and validate features from live runs.
- [ ] Split by task.
- [ ] Record decision disagreements with the static controller.
- [ ] Measure false-safe rate.

### Control

- [x] Add deterministic test-log reduction.
- [x] Retain and hash the raw log artifact.
- [x] Suppress equivalent retries against a trusted snapshot.
- [x] Cap each new response.
- [x] Add request-budget and conservative stop paths.

### Evaluation

- [x] Create scripted seeded-bug scenarios and a clean control.
- [x] Run deterministic hard-cap, static, and shadow traces.
- [x] Apply the scripted quality gate before showing synthetic cost.
- [ ] Replay predictive disagreements from matched prefixes.
- [ ] Freeze final holdout results.

### Experience

- [x] Build the scripted timeline.
- [x] Show policy, synthetic settled cost, reservation, and final reserve.
- [x] Show risk band, mode, and scripted drivers.
- [x] Mark interventions.
- [x] Build the scripted three-arm comparison.
- [x] Label demo, replay, and synthetic data.
- [ ] Add and separately label a measured live path.

### Demo

- [ ] Keep a captured trace fallback.
- [ ] Rehearse the ninety-second script.
- [ ] Verify all displayed numbers.
- [ ] Prepare judge Q&A.
- [ ] Stop on the final comparison screen.

## 36. Final Recommendation

Governor now demonstrates a narrow deterministic control loop for one AI
workflow through fake-provider tests and a scripted dashboard:

```text
count and reserve the next request
    -> settle reported usage (scripted in current tests)
    -> apply deterministic controls
    -> verify quality
    -> compare cost
```

The adversarial design pass and technical POC are complete, but production
readiness and economic value are not established. Next, run the same restricted
workflow against a live provider on a frozen holdout, reconcile usage, and
compare cost only after the quality gate passes. Keep prediction as an
incremental shadow signal until it beats the same controller without
prediction.

## 37. Sources and Implementation References

- [OpenAI Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI token counting guide](https://developers.openai.com/api/docs/guides/token-counting#api-reference)
- [OpenAI conversation state guide](https://developers.openai.com/api/docs/guides/conversation-state#managing-context-for-text-generation)
- [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction#standalone-compact-endpoint)
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [Ramp AI usage developer guide](https://docs.ramp.com/developer-api/v1/ai-usage)
- [Dissociating Decodability and Causal Use in Bracket-Sequence Transformers](https://doi.org/10.48550/arXiv.2604.22128)

OpenAI and Ramp capabilities, pricing, and schemas can change. Recheck the
linked documentation immediately before implementation and before presenting
any provider-specific claim.
