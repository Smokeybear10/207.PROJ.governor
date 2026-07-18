# Governor Core Work Log

## Purpose

This is the canonical record of the governor-core work assigned to me for
Governor. I will update it whenever I change governor behavior, tests, or
design decisions.

The governor core is the deterministic financial-control layer. It decides
whether an AI request can fit within a fixed job budget, reserves the
worst-case cost before dispatch, reconciles actual usage afterward, and stops
unsafe or unresolved execution.

## My Scope

I own:

- Fixed-point token-cost calculation and versioned rate cards
- Request admission and worst-case cost reservation
- Output-token caps and final-answer budget protection
- Reservation lifecycle and provider-usage settlement
- Ambiguous request, cancellation, rejection, and stop handling
- Retry fingerprinting and equivalent-retry limits
- Deterministic risk bands and ledger-aware risk assessment
- Test-log reduction and credential redaction
- Governor-focused unit and integration tests

Primary files:

- `server/governor/cost.ts`
- `server/governor/ledger.ts`
- `server/governor/risk.ts`
- `server/governor/retry.ts`
- `server/governor/log-reducer.ts`
- `server/governor/errors.ts`
- `server/governor/index.ts`
- `tests/governor-*.test.ts`

I do not own:

- OpenAI HTTP requests or response parsing
- Public jobs API routes
- CLI commands
- PR-review workflow orchestration
- Dashboard UI and demo presentation

The core accepts exact token counts and provider-reported usage through typed
inputs. It does not need to know how those values were obtained and does not
call OpenAI directly.

## End-to-End Flow

```text
Policy + versioned rate card
            |
            v
Exact proposed input-token count
            |
            v
Calculate worst-case input and output cost
            |
            v
Reserve cost and apply an affordable output cap
       |                           |
       | denied                    | admitted
       v                           v
Stop safely                 Bind and dispatch request
                                      |
                                      v
                         Reconcile provider-reported usage
                            |         |          |
                            v         v          v
                         settle    release    ambiguous
                                      |          |
                                      v          v
                               free reserve   retain reserve
```

For final responses, settlement is not enough to close the job. The
application must explicitly accept or reject the final output.

## Core Components

### Cost Calculator

`cost.ts`:

- Stores pricing as integer micro-USD per million tokens.
- Uses integer arithmetic and ceiling division instead of floating-point
  currency math.
- Separates uncached input, cached input, cache-write input, and output.
- Avoids charging reasoning tokens twice when they are already included in
  output usage.
- Calculates a conservative worst-case request cost.
- Calculates the largest affordable output-token cap.

### Reservation Ledger

`ledger.ts`:

- Enforces one unresolved request at a time.
- Protects a final-answer reserve from ordinary work requests.
- Reserves worst-case cost before dispatch.
- Binds reservations to the context hash, model, service tier, region, rate
  card, and dispatched-request hash.
- Settles only from validated provider usage and response evidence.
- Retains reservations after ambiguous transport or usage outcomes.
- Prevents replaying one provider response ID across multiple requests.
- Requires explicit final-response validation before closing a completed job.

Important states:

```text
reserved -> in_flight -> settled
                     -> released
                     -> ambiguous -> settled after reconciliation
```

### Retry Controller

`retry.ts`:

- Canonicalizes tool arguments so object key order does not change identity.
- Hashes the tool name, arguments, error class, and trusted state revision.
- Distinguishes a first failure, equivalent retry, material state change,
  transient failure, and exhausted retry limit.
- Does not consume the equivalent-retry budget for transient infrastructure
  failures.

### Risk Assessment

`risk.ts`:

- Emits `SAFE`, `WATCH`, or `AT_RISK`.
- Reports observed drivers such as budget use, context growth, retry count,
  failed tools, final-reserve pressure, and missing completion capacity.
- Runs in shadow mode and cannot increase spending authority.
- Derives accounting inputs directly from a ledger snapshot through
  `assessLedgerRisk`.

### Log Reduction

`log-reducer.ts`:

- Redacts common API keys, authorization values, passwords, and private keys
  before hashing or model exposure.
- Extracts failing tests and relevant error lines.
- Deduplicates repeated errors while preserving occurrence counts.
- Produces bounded excerpts and records omitted content.
- Keeps a content hash and size estimate for the sanitized raw artifact.

## Safety Invariants

The governor must always preserve these rules:

1. A request is never dispatched before its worst-case cost is reserved.
2. Settled cost plus outstanding reservations never exceeds the job ceiling.
3. Work requests cannot consume the protected final-answer reserve.
4. The output cap cannot exceed either the requested cap or the affordable
   cap.
5. Only one request may be unresolved for a job.
6. Ambiguous dispatched requests retain their reservation.
7. Usage must match the exact preflight input and reserved output bound.
8. Model, tier, region, and rate-card identity cannot silently change.
9. A provider response ID cannot settle more than one request.
10. A final response does not close the job until the application validates
    it.
11. Risk assessment may report danger but cannot grant more budget.
12. Sensitive log values are redacted before persistence or model exposure.

## Work Completed

### 2026-07-18: Governor Core Foundation

- Implemented versioned rate cards and fixed-point micro-USD calculations.
- Added provider-usage normalization and conservative rounding.
- Added worst-case reservation calculation and affordable output caps.
- Implemented the in-memory reservation ledger and request state machine.
- Protected the final-answer reserve and response slot.
- Added request and pricing identity binding.
- Added settlement, ambiguity, reconciliation, cancellation, and final
  validation behavior.
- Added deterministic retry fingerprints and retry-limit enforcement.
- Added deterministic risk bands in shadow mode.
- Added bounded test-log reduction and credential redaction.

### 2026-07-18: Current Core Hardening

- Updated the pinned rate card to reference the official developer pricing
  page.
- Added definitive provider-rejection evidence for non-timeout `4xx`
  responses, allowing a dispatched reservation to be safely released only
  when non-execution is known.
- Added `closeStoppedJob` so an inactive job can be permanently sealed after a
  safe stop.
- Corrected equivalent-retry boundary semantics so a configured value of `N`
  permits exactly `N` equivalent retries after the first failure.
- Added `assessLedgerRisk`, which derives settled cost, outstanding reserve,
  final reserve, retry limit, and remaining responses from a ledger snapshot.
- Prevented ledger-aware risk assessment from double-counting the protected
  final reserve while a final request is already reserved.
- Added governor-core integration coverage connecting reservation state,
  retry observations, and risk assessment.

Verification:

- Governor-focused tests: 43 passed
- Complete test suite: 211 passed
- TypeScript typecheck: passed

### 2026-07-18: Governor-Core Demo Connection

Goal:

- Make the dashboard demonstrate the real governor core without adding live
  OpenAI or other provider calls.

Implementation:

- Added exact input, requested output, minimum useful output, and request phase
  metadata to every synthetic demo request.
- Updated each demo policy with a fundable final-input limit and minimum final
  output. The large-log scenario protects 25,000 micro-USD, the clean scenario
  protects 8,000, and the retry scenario protects 21,000.
- Replaced fixture-authored accounting with a real `ReservationLedger` for
  each run. Request events now call `reserve` and `dispatch`, response events
  call `settle`, successful quality events call `finalizeFinalResponse`, and
  stopped runs call `closeStoppedJob`.
- Replaced the demo's duplicate pricing calculation with
  `GPT_5_4_MINI_STANDARD_RATE_CARD` and `calculateUsageCost`.
- Connected retry fixtures to `RetryFingerprintTracker` and event risk bands
  to `assessLedgerRisk`. Narrative fixture drivers remain visible alongside
  drivers derived by the core.
- Added `GOVERNOR_CORE_ENFORCED` provenance and exposed requested versus
  admitted output caps in the execution timeline.
- Preserved the truth boundary: all usage, responses, timings, and PR data are
  deterministic synthetic inputs, and external API calls remain zero.

Observed core decision:

- In the large failing-log scenario, the continuation requests 5,000 output
  tokens. The core admits a 3,384-token cap so settled cost, the new
  reservation, and the 25,000 micro-USD final reserve stay within the 75,000
  micro-USD ceiling.

Safety impact:

- Demo requests now exercise the same pre-dispatch reservation and
  post-response settlement invariants as the production-facing runtime.
- A closed ledger now reports `SAFE` because no future request can spend from
  it; risk observations are still validated before that terminal override.

Tests:

- Added assertions that every visible reservation equals the core's
  worst-case request calculation.
- Added coverage for the governor-imposed output-cap reduction and terminal
  closed-ledger risk.
- Updated dashboard coverage for core provenance and visible output caps.

## Known Boundaries

- Ledger state is process-local memory and is lost on restart.
- The ledger is synchronous and does not provide cross-process transactions.
- Live cancellation and timeout reconciliation still require provider-level
  validation.
- Risk bands are deterministic shadow signals, not a trained forecast.
- The governor enforces list-price policy; it is not an invoice or billing
  system.
- The current API surface is a proof of concept, not authenticated
  multi-tenant infrastructure.

## How I Explain My Contribution

### One Sentence

I built the deterministic budget-enforcement core that pre-authorizes every AI
request against a fixed ceiling and reconciles actual token cost afterward.

### Thirty Seconds

The governor works like a card authorization system for AI requests. Before a
request runs, it uses the exact input-token count and maximum output to reserve
the worst-case list-price cost. It reduces the output cap or rejects the
request when the budget cannot support it. Afterward, it validates
provider-reported usage and replaces the reservation with actual cost. It also
protects final-answer capacity, retains uncertain charges after timeouts,
limits repeated failures, and emits deterministic risk signals.

### Technical Detail

The accounting uses integer micro-USD values and conservative ceiling
rounding. Each reservation is bound to context, request, pricing, model, tier,
and region identities. The state machine rejects concurrent unresolved
requests, usage mismatches, cap breaches, and replayed response IDs. Ambiguous
outcomes remain reserved until reconciliation, which prevents retries from
silently exceeding the job budget.

## Commands I Use

Run only the governor-focused suite:

```bash
npm test -- --run \
  tests/governor-core.test.ts \
  tests/governor-cost-ledger.test.ts \
  tests/governor-policy.test.ts \
  tests/governor-log-reducer.test.ts
```

Run the complete test suite:

```bash
npm test
```

Check TypeScript:

```bash
npm run typecheck
```

## Entry Template

Copy this section for each future governor-core change:

```text
### YYYY-MM-DD: Short Change Name

Goal:

- What problem I needed to solve

Implementation:

- Files and behavior changed
- Important design decision

Safety impact:

- Invariant added, changed, or preserved

Tests:

- Test cases added or updated
- Commands run and results

Remaining work:

- Known limitation or follow-up
```
