# TokenGovernor — Project Status Report

What is built, how it works, and what is blocking. Written for the team and
for judges/handoff. Snapshot as of the current main; re-run the health checks
before quoting anything.

## One-line state

A deterministic budget-control layer for AI agents is built and green
(233 tests, clean typecheck) across a CLI, a jobs API, two governed
workloads, a dashboard, and a published VS Code extension. The single
biggest open risk is that **no live OpenAI run has been confirmed** —
everything demoed so far uses scripted or synthetic providers.

## What was built (surfaces)

| Surface | What it is | Where | Owner |
| --- | --- | --- | --- |
| Governor core | The enforcement kernel: count, price, reserve, cap, settle; retry suppression; risk bands; log reduction | `server/governor/` | Thomas |
| Jobs API | `/v1/jobs` lifecycle (create, submit response, inspect, finalize) | `server/jobs/`, `server/app.ts` | Thomas |
| CLI | Terminal wrapper over the jobs API | `cli/token-governor.ts` | Thomas |
| PR-review workload | Multi-step review with allowlisted repo tools | `server/review/` | Thomas |
| CI-repair workload | Governed repair loop: sandbox, tools, budget tools, sealed evaluator | `server/repair/` | Thomas / Aryan |
| Sealed evaluator | Scores repairs against isolated ground truth that can't be gamed | `server/repair/evaluation.ts` | Aryan |
| Dashboard | React UI: Dashboard, CI-Repair panel, Brand Studio | `src/` | Aarav (pitch pass), Thomas |
| VS Code extension | Sidebar spend/risk, budget outlook, send prompt, submit selection | `vscode-extension/` | Aarav (built), Aryan (published + client libs) |
| Station tooling | Rehearsal server, scripted demo script, eval runner | `station/` | Aarav |
| Docs | Announcements, strategy, tasks, interventions, demo map, this report | `docs/hackathon/` | Aarav |

## How it works (the loop)

```
CLI / extension / dashboard
      -> jobs API (/v1/jobs)
      -> governed executor
      -> governor core  (count -> price -> reserve -> cap -> settle)
      -> OpenAI client (or scripted provider)
```

1. A person sets a **dollar budget** (e.g. $0.075). Not tokens — the governor
   converts tokens to dollars with a pinned rate card.
2. Before every model call the governor counts the exact input, reserves the
   worst-case cost, and caps the output so one call can't blow the budget.
3. After the call it settles the real usage against the reservation.
4. It protects a slice of budget for the final answer, and **denies** any call
   that can't fit — spending simply stops, the denied call costs nothing.
5. Quality is scored by an independent evaluator, not the model itself.

Two workloads run on this same core: **PR review** and **CI repair**. CI
repair is the stronger economic story (frequent retries, machine-verifiable
outcome) per the POC findings.

## Current health

- **Typecheck:** clean (`npm run typecheck`).
- **Tests:** 233 passing (`npm test`).
- **Build:** `npm run build` (tsc + vite).
- **Flaky test:** the repair-sandbox test (`broken-sum`) is timing-sensitive
  and has failed intermittently on a loaded machine, then passed on rerun.
  Not a logic bug, but re-run before trusting a red result.

## Blockers and open risks

1. **No confirmed live OpenAI run (highest priority).** Without
   `OPENAI_API_KEY` the provider fails closed with `PROVIDER_NOT_CONFIGURED`.
   The Codex/OpenAI track needs at least one real governed run with measured
   provider usage. Until then, every dollar shown is scripted or synthetic.
   Owner: Aryan. Fallback: `npm run station:demo` (real ledger, scripted model).
2. **No persistence.** Job/ledger state is an in-memory `Map`
   (`server/jobs/service.ts`); a server restart wipes it. Deliberate and
   documented; durable storage is Phase 2. Don't migrate mid-hackathon — it
   risks the exact-ledger demo.
3. **Extension is published to the marketplace.** Any extension code change
   needs a republish + reinstall to reach users. During active editing, run
   from source (F5) instead so changes take effect immediately.
4. **Prediction is shadow-only.** The forecast/risk layer has no measured
   decision lift yet; keep it labeled non-acting. Enforcement is deterministic
   and real; the forecast is advisory (POC_FINDINGS.md).
5. **Extension budget-outlook estimate is optimistic-by-one.** It can say
   "room for ~1 more" right before the governor denies the next call. The
   warning color is timely; the exact count is a rough estimate. Safe because
   the hard budget still enforces — the estimate has no authority.

## Truth boundary (say this precisely)

- Enforcement kernel, receipts, and evaluator are **real code, tested**.
- Dashboard scenarios and benchmark are **labeled synthetic fixtures**.
- A live OpenAI run, once captured, is the only thing labeled **live**.
- Never call a scripted or replayed run "live."

## Re-run the checks

```bash
npm run typecheck
npm test
npm run build
npm run station:demo      # full governed loop, no API key needed
```
