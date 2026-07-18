# TokenGovernor

**The budget-aware execution layer for AI agents.**

This repository contains a working proof of concept for deterministic,
per-job model-cost enforcement. It counts a proposed OpenAI Responses API
request, reserves its conservative maximum list-price cost before dispatch,
caps output, and settles provider-reported usage against a fixed policy.
The multi-step pull-request review workflow is integration-tested with a
scripted fake Responses provider; it has not made a live OpenAI call.

The included dashboard is a scripted mechanism walkthrough. Its scenarios,
usage, receipts, timing, quality results, and costs are deterministic synthetic
fixtures. No external model calls were made to produce the displayed results.

## Current truth boundary

- The enforcement kernel, provider adapter, governed executor, artifact store,
  multi-step review workflow, demo API, and dashboard are implemented and
  tested.
- The OpenAI adapter permits local function tools only, disables parallel tool
  calls and provider storage, and never retries an ambiguous model request.
- Admission records a canonical context hash, binds model, default request
  tier, processing region, provider, and rate-card version to the reservation,
  then records the exact dispatched-request hash. Settlement rechecks the
  provider response model and tier.
- A completed final response remains pending until the application explicitly
  validates its output and closes the job as accepted or rejected.
- Equivalent tool retries are suppressed only against the same trusted,
  immutable repository snapshot; transient failures do not consume that retry
  budget.
- The dashboard does not show measured usage, a real benchmark, customer
  savings, invoice control, or production readiness.
- The ledger and active workflow state are single-process memory. A restart
  loses them, and there is no transactional cross-process coordination or
  recovery.
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
- Memory and file-backed content-addressed raw artifact stores
- Three deterministic scenarios across hard-cap, static, and predictive-shadow
  controllers
- Responsive dashboard with trace playback, accounting, interventions,
  receipts, and a quality-gated mechanism comparison

## Repository map

- `server/governor/`: policy, cost, reservation, retry, risk, and log reduction
- `server/openai/`: restricted no-retry Responses API adapter
- `server/runtime/`: integrated count, reserve, dispatch, and settle flow
- `server/artifacts/`: bounded content-addressed artifact persistence
- `server/demo/`: deterministic scenarios, traces, and reconciled receipts
- `src/`: React operations dashboard
- `tests/` and `e2e/`: unit, integration, API, and browser coverage
- `docs/`: design and POC findings

## Run locally

Requires Node.js 18 or later.

```bash
npm ci
npm run dev
```

The dashboard runs at `http://127.0.0.1:5173`; the API health endpoint is
`http://127.0.0.1:8787/api/health`.

```bash
npm test
npm run typecheck
npm run build
npm run test:e2e
```

The current HTTP surface is intentionally demo-only:

- `GET /api/health`
- `GET /api/demo/catalog`
- `POST /api/demo/runs`
