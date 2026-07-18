# TokenGovernor — Work Summary

A spend firewall for AI agents. Every model call goes through a deterministic
**count → price → reserve → cap → dispatch → settle** pipeline, so cost is
enforced before the call, not discovered after it.

## Architecture (4 layers)

1. **Frontend** — React dashboard (`src/`): job monitor, Brand Studio, CI-Repair panel.
2. **Shared API** — Express app (`server/app.ts`): `/api/repair/runs`, `/v1/jobs*`, uniform JSON error envelope.
3. **Repair layer** (`server/repair/**`) — governed autonomous CI-repair agent.
4. **Governor service** (`server/jobs/service.ts`) — the single spend authority; count/price/reserve/cap/dispatch/settle over `server/governor/**` + `server/runtime/**`.

## What we shipped this session

- **Repair layer routed through the governor service.** Repair no longer embeds its own ledger; it drives `GovernedJobService` via a typed adapter (`server/repair/governor-client.ts` → `openRepairSession`). Frontend → shared API → repair → governor service.
- **CI-Repair panel in the frontend** wired to `POST /api/repair/runs`.
- **Sealed evaluator hardened.** Final verification runs in a **fresh pristine checkout** that carries over only the agent's allowlisted file contents (`verifyFinalState` in `server/repair/sandbox.ts`). Tampering outside the allowlist can't fake a green build. Added an anti-gaming test.
- **VS Code / Cursor extension** — interactive UI (see `EXTENSION.md`): toolbar, live budget dashboard, in-panel CI-repair results + governed trace. Logo + marketplace README added, packaged as a `.vsix`, installed locally.
- **Docs reconciled** (`README.md`, `docs/CI_REPAIR.md`) to the service-driven architecture.

## Verification

- `npx tsc --noEmit`: clean.
- `npx vitest run`: **233/233** passing (22 files).
- `vite build`: clean.
- Extension: typecheck clean, 7/7 unit tests, mock-publish + VSIX package OK.
- Live smoke: `POST /api/repair/runs` (fake `broken-sum`) → `201 repaired`, sealed eval passed, spend ~$0.0045.

## How it saves money (cost-control tactics)

Implemented ✅:

- Count before you call (free exact-size preflight)
- Set money aside, then refund (reserve → settle)
- Cap the answer length (`max_output_tokens`)
- Don't repeat dead-end work (retry-fingerprint suppression)
- Shrink giant logs (reduce test logs to the failing lines)
- Reuse instead of resend (content-addressed artifacts)
- Always keep enough to finish (protected final-answer reserve)
- Quit while you're ahead (refuse over-budget calls, stop cleanly)
- Use the cheapest model that works (low-cost default)

Roadmap ◻:

- Only run the tests that matter
- Look before you read (fault localization)
- Ignore unreliable/flaky tests

## Run it

```bash
npm start                      # governor API on http://127.0.0.1:8787 (scripted, $0)
OPENAI_API_KEY=... npm start   # live OpenAI calls
npm run dev:web                # React dashboard
```
