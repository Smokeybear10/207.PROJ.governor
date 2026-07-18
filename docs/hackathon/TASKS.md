# Team Tasks and Requirements

Granular task board for the 11 AM - 3 PM build window. Hard freeze 3:00 PM,
internal freeze 2:30 PM, rehearsal 2:40 PM at the station.

## What the MVP is

A budget-control API for AI jobs, driven from a CLI and an IDE:

1. `POST /v1/jobs` creates a governed budget.
2. `POST /v1/jobs/:id/responses` submits work through the governor.
3. `GET /v1/jobs/:id` shows spending, reservations, and remaining budget.
4. `GET /v1/jobs/:id/responses/:requestId` retrieves a stored result.
5. `POST /v1/jobs/:id/finalize` accepts or rejects the final output.

CLI → job/workflow → governed executor → governor core → OpenAI client.
The dashboard is a supporting demo surface, not the MVP.

## Requirements mapped to judging criteria

| Criterion | What we show | Owner |
| --- | --- | --- |
| Technical complexity | Deterministic enforcement kernel, 201 tests, reserve-before-dispatch math | Thomas (done, keep green) |
| Pitch | 15-second story, 90-second finalist script, judge Q&A | Azdeen |
| Idea quality | "Hard caps kill jobs; Governor lands them under budget" told with one live run | Everyone |
| Investable | Per-job budget receipts, path from API to team budgets and finance reporting | Azdeen (script), Thomas (receipts) |
| Track fit: Save Time. Save Money. | Dollar numbers on screen at every step | All |
| Track fit: Best Use of OpenAI API | At least one real governed OpenAI run through /v1/jobs | Aryan |

## Thomas — pipeline / core

- [x] Governor core: count, price, reserve, cap, settle
- [x] Jobs API (/v1/jobs lifecycle) + CLI wrapper
- [ ] Keep `npm run check` green on main
- [ ] Receipt output a judge can read (job show: settled, reserved, remaining,
      risk, per-response statuses)
- [ ] Freeze demo fixtures by 2:30

## Aryan — AI integration, evaluator, plugin conversion

- [ ] Live OpenAI run through the governed path (`OPENAI_API_KEY=... npm start`,
      then job create → response create → finalize)
- [ ] Verify provider-reported usage settles correctly against the reservation
- [ ] Record at least one successful live trace before 2:30 as the Codex-track
      proof; screenshot the receipt
- [ ] Redeem Codex credits (email after check-in; Tyler is the contact)
- [ ] Evaluation runner: score frozen runs against sealed ground truth, cost
      per successful task (picked up from Aarav's stretch list)
- [ ] Converting Aarav's `vscode-extension/` into a plugin — confirm target
      (Cursor-specific packaging vs. something else) so nobody duplicates
      the sidebar work; extension already works unmodified in Cursor since
      it's a VS Code fork, worth checking before rebuilding anything

This is a lot on one person with a hard 3:00 freeze — flag early if any of
these three need to be dropped rather than discovering it at 2:45.

## Azdeen — caveats and pitch

- [ ] 90-second finalist script (docs/TOKEN_GOVERNOR.md section 20 as the base)
- [ ] Judge Q&A prep (sections 27 and 30)
- [ ] Truth-boundary language: synthetic vs live, safe claims only
      (section 31)
- [ ] Station setup: what runs on which screen
- [ ] Submit to Save Time. Save Money. + Best Use of OpenAI API/Codex +
      Audience Favorite

## Aarav — IDE surface and docs

See docs/hackathon/AARAV.md for the granular list.

- [x] VS Code extension: create job, submit work, live spend + risk band in
      the status bar, WATCH / AT_RISK step flags (validate in dev host next)
- [x] Repo unblocked (missing artifacts module restored)

## Demo plan (station)

1. Screen 1: terminal. Create a job with a $0.075 budget, submit work through
   the governor, show the receipt.
2. Screen 2 (VS Code): same job's spend and risk band live in the status bar;
   at-risk steps flagged.
3. If asked "what happens without it": the dashboard comparison showing the
   hard-cap arm dying versus the governed arm delivering.
4. Close on the dollar line: what it cost, what the ceiling was, what got
   delivered.
