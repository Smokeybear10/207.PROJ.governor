# Governor

**The budget-aware execution layer for AI agents.**

This repository contains a working proof of concept for deterministic,
per-job model-cost enforcement. It counts a proposed OpenAI Responses API
request, reserves its conservative maximum list-price cost before dispatch,
caps output, and settles provider-reported usage against a fixed policy.
The multi-step pull-request review workflow is integration-tested with a
scripted fake Responses provider; it has not made a live OpenAI call.

The terminal CLI and versioned HTTP API are the primary POC customer
experience. The optional React dashboard is a scripted mechanism walkthrough;
its scenarios, usage, receipts, timing, quality results, and costs are
deterministic synthetic fixtures. No external model calls produced them.

## Current truth boundary

- The enforcement kernel, provider adapter, governed executor, artifact store,
  multi-step review workflow, governed jobs API, terminal CLI, demo API, and
  dashboard are implemented and tested.
- `POST /v1/jobs` creates an in-memory budget ledger. Each
  `POST /v1/jobs/:jobId/responses` request is preflighted and, if admitted,
  reserved before one dispatch. Terminal provider usage settles the
  reservation.
- A `request_id` is an idempotency key within its job. Concurrent or later
  submissions with the same ID and response intent share the stored outcome
  without another provider dispatch; reuse for a different intent returns
  `409 REQUEST_ID_CONFLICT`. The response retrieval route is
  `GET /v1/jobs/:jobId/responses/:requestId`.
- Genuine post-dispatch ambiguity returns `202`, retains the full reservation,
  and locks the job in `reconciliation_required`. Reconciliation is required
  before more work, but the POC has no public reconciliation endpoint.
- Final output must be explicitly accepted or rejected through
  `POST /v1/jobs/:jobId/finalize`.
- The OpenAI adapter permits local function tools only, disables parallel tool
  calls and provider storage, and never retries an ambiguous model request.
- Admission records a canonical context hash, binds model, default request
  tier, processing region, provider, and rate-card version to the reservation,
  then records the exact dispatched-request hash. Settlement rechecks the
  provider response model and tier.
- A completed final response remains pending until the application explicitly
  validates its output and closes the job as accepted or rejected.
- The built-in PR-review workflow suppresses equivalent tool retries only
  against the same trusted, immutable repository snapshot; transient failures
  do not consume that retry budget. The generic jobs API does not classify
  tool retries.
- The dashboard does not show measured usage, a real benchmark, customer
  savings, invoice control, or production readiness.
- The ledger and active workflow state are single-process memory. A restart
  loses them, and there is no transactional cross-process coordination or
  recovery.
- The governed API is an unauthenticated localhost POC, not a public,
  multi-tenant service.
- Static and predictive-shadow demo arms have identical cost. Prediction has
  not established incremental value and cannot change execution.
- The strongest current claim is deterministic budget middleware, not cost
  forecasting.

See [`docs/POC_FINDINGS.md`](docs/POC_FINDINGS.md) for the adversarial verdict
and next falsification experiment. The full product and technical design is in
[`docs/TOKEN_GOVERNOR.md`](docs/TOKEN_GOVERNOR.md).

## Implemented POC

- Versioned integer-micro-USD rate cards and conservative reservation math
- Exact input-token preflight through `POST /v1/responses/input_tokens`
- One unresolved response at a time, output caps, response limits, and a
  protected final-answer reserve
- Canonical context and dispatched-request hashes with pinned pricing identity
- Explicit application validation after final-response settlement
- Safe-stop handling for transport ambiguity, missing usage, and usage mismatch
- Trusted-state retry suppression and bounded test-log reduction
- A multi-step review loop exercised through a scripted fake provider
- A terminal CLI and HTTP API for creating, running, retrieving, inspecting,
  and finalizing governed jobs
- Idempotent response submission with stored-outcome replay and conflict
  detection
- Memory and file-backed content-addressed raw artifact stores
- Three deterministic scenarios across hard-cap, static, and predictive-shadow
  controllers
- Responsive dashboard with trace playback, accounting, interventions,
  receipts, and a quality-gated mechanism comparison

## Repository map

- `server/governor/`: policy, cost, reservation, retry, risk, and log reduction
- `server/openai/`: restricted no-retry Responses API adapter
- `server/runtime/`: integrated count, reserve, dispatch, and settle flow
- `server/jobs/`: in-memory governed-job API service and exact USD conversion
- `server/artifacts/`: bounded content-addressed artifact persistence
- `server/demo/`: deterministic scenarios, traces, and reconciled receipts
- `cli/`: terminal client for live governed jobs and scripted demo traces
- `src/`: React operations dashboard
- `tests/` and `e2e/`: unit, integration, API, and browser coverage
- `docs/`: design and POC findings

The intended dependency direction is:

```text
CLI -> HTTP API -> jobs/runtime -> governor core
                         |
                         +-> OpenAI adapter
```

`server/governor/**` does not import the HTTP, CLI, runtime, or provider
adapters. `server/main.ts` is the executable API entry point;
`server/index.ts` is an importable, side-effect-free library facade.

## Run locally

Requires Node.js 18 or later.

```bash
npm ci
npm start
```

In another terminal, inspect the service and play a no-key synthetic trace:

```bash
npm run governor -- health
npm run governor -- demo \
  --scenario large-failing-log \
  --controller static
```

Create and inspect a real governed job ledger:

```bash
npm run governor -- job create --budget 0.075
npm run governor -- job show job_replace_me
```

To dispatch live responses, start the server with `OPENAI_API_KEY` configured.
Jobs are process-local, so create the live job after that server starts:

```bash
OPENAI_API_KEY=... npm start
```

In another terminal, create the job, set its returned ID, submit a response, and
retrieve the stored outcome:

```bash
npm run governor -- job create --budget 0.075
JOB_ID=job_replace_me
npm run governor -- response create \
  --job "$JOB_ID" \
  --request review:work:1 \
  --phase work \
  --input "Review this change"
curl -sS "http://127.0.0.1:8787/v1/jobs/${JOB_ID}/responses/review%3Awork%3A1"
```

The API accepts decimal USD as strings and returns both exact integer
micro-USD and six-decimal USD fields. `minimum_output_tokens` (CLI
`--min-output`) is an admission floor: the call is denied if the affordable
output cap falls below it. It does not require or guarantee that the model
generates that many tokens.

Equivalent-retry classification belongs to the built-in PR-review workflow.
The generic jobs API does not expose that workflow-specific policy.

A completed final response leaves the job in `validation_required` until the
application explicitly accepts or rejects it. To run the API and optional
dashboard together instead, use `npm run dev`; the dashboard is at
`http://127.0.0.1:5173` and the API is at `http://127.0.0.1:8787`.

```bash
npm run test:core
npm run test:api
npm run typecheck
npm run build
npm run test:e2e
```

The terminal-first HTTP surface is:

- `POST /v1/jobs`
- `GET /v1/jobs/:jobId`
- `POST /v1/jobs/:jobId/responses`
- `GET /v1/jobs/:jobId/responses/:requestId`
- `POST /v1/jobs/:jobId/finalize`

The separate synthetic walkthrough surface is:

- `GET /api/health`
- `GET /api/demo/catalog`
- `POST /api/demo/runs`
