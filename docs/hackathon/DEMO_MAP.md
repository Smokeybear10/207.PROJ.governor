# Demo Map — One Obvious Moment Per Judging Category

This project is hard to demo because the value (deterministic budget
enforcement) is invisible if you just watch an agent run. So we don't ask the
judge to infer anything. Each of the five judging categories gets **one
scripted moment where the point is impossible to miss.**

## The one-line frame (say this first, every time)

> "Ramp is a corporate card that stops overspending before it happens.
> We built the same thing for AI agents. Every model call gets pre-authorized
> against a budget, money is held before the call, and you get a receipt after.
> A hard limit kills the agent when the money's gone. Ours lands the job
> *under* budget."

Corporate-card words map 1:1 onto what the code does. Use them out loud:

| Ramp card concept | Governor does | Where it shows |
| --- | --- | --- |
| Pre-authorization | Count the exact request before dispatch | CLI: reservation |
| Hold / pending charge | Reserve the worst-case cost up front | Sidebar: reserved bar |
| Decline over limit | Refuse a call that can't fit the budget | CLI: `denied` |
| Settled transaction | Settle real usage after the call | CLI: `settled` |
| Receipt | Final job accounting a human accepts | CLI: receipt / finalize |

## The 5 obvious moments

### 1. Idea quality — the 15-second hook

**On screen:** dashboard idle state (`?station` off), the title
*"AI agents that finish under budget"* and the pre-run briefing card showing
`This job's budget $0.075` with `$0.015 protected for the final answer`.

**Say:** "A hard cap is a stop sign — it kills the agent mid-task and you've
paid for nothing. A governor is a steering wheel — it changes what the agent
does next so it still finishes, under budget."

**Why it's obvious:** the judge sees a dollar budget and the words "finish
under budget" before anything runs. The idea is legible in one sentence.

### 2. Track fit (Save Time. Save Money.) — cost per *successful* task

**On screen:** the dashboard comparison (hard_cap vs governed). The verdict
line reads exactly: *"The hard cap burned $0.018600 and shipped nothing. The
governed run shipped a passing review for $0.044925."* Hard-cap arm shows
*"Stopped by policy before delivery"* in red; governed arm passes the gate.

**Say this — and get the direction right, the screen shows it:** "The hard cap
is actually the *cheaper* run — $0.0186. But it shipped nothing, so that money
is pure waste. The governed run costs more in raw dollars, $0.0449, but it
delivered a review that passed the quality gate, and it stayed under the
$0.075 ceiling. The number that matters isn't cost per call — it's cost per
*successful task*. The hard cap's is infinite. Ours is $0.0449."

**Do NOT say** "governed is cheaper." It isn't, and the screen proves it. The
whole honesty of the pitch is that we lead with cost-per-success, not raw
token savings (a stopped agent is always cheaper and always useless).

**Why it's obvious:** the "shipped nothing vs shipped a passing review"
contrast is the entire idea in one frame, and stating it against your own
higher dollar number is what makes it credible instead of a magic-savings
claim.

### 3. Technical complexity — the live governed loop

**On screen:** the terminal (`npm run station:demo`, or a live
`OPENAI_API_KEY` run). Walk the four printed steps:
`job create` → `response create (work)` → `response create (final)` →
`finalize` → receipt.

**Say, pointing at each line:** "Before every call it counts the exact input.
It reserves the worst-case cost — see `reserved`. It caps the output so one
call can't blow the budget. After the call it settles the real usage — see
`settled` drop below the reservation. And it protects `$0.015` so there's
always enough left to deliver the final answer."

**Real numbers from the rehearsal run:** budget `$0.075000`, settled
`$0.008205` across two governed calls, job `completed`, receipt clean.

**Why it's obvious:** the reserve-then-settle two-step is visible in plain
text. It's obviously not a token counter or a `max_tokens` flag — it's a
pre-auth/settle ledger. 200+ passing tests back the claim if asked.

### 4. Investable — it lives where developers already work

**On screen:** VS Code (or Cursor) with the Governor sidebar open. Same job
from step 3. Highlight text, run *Submit Selection Through Governor*, watch the
status bar go green → yellow (WATCH 70%) and the sidebar committed number climb.

**Say:** "This isn't a dashboard you check after the fact. It's a control
layer that sits in the editor and in CI, on top of any agent. Today: per-job
budgets and receipts. Next: team budgets, then it feeds Ramp's finance side —
engineering sees the technical cause, finance sees budget adherence."

**Why it's obvious:** a plugin inside the IDE is a product a company installs,
not a science project. The path from "one job" to "team budgets" to "Ramp
integration" is the roadmap, stated in one breath.

### 5. Pitch / honesty — the truth boundary

**On screen:** the truth strip in the header
(`GOVERNOR CORE / SCRIPTED INPUTS / 0 EXTERNAL CALLS`) and the collapsed
provenance line.

**Say:** "We're precise about what's real. The enforcement kernel and the
receipts are real code, tested. The dashboard fixtures are labeled synthetic.
Our one live OpenAI run is labeled live. We never call a replay 'live.'"

**Why it's obvious:** volunteering the truth boundary before a judge asks is
the strongest possible answer to "is this real?" It reads as senior, not
defensive.

## Station choreography (science-fair, no driver)

Screens left to right so a passer-by reads it in order:

1. **Dashboard on `?station`** — auto-loops hard_cap (dies) then governed
   (delivers). This runs unattended and is the 15-second magnet. The verdict
   banner and comparison line do the talking.
2. **Terminal** — the receipt from a real governed run, frozen on screen.
3. **VS Code sidebar** — the same job's spend and risk band.

When someone stops, narrate in category order: idea (screen 1 title) → money
(screen 1 comparison) → how it works (screen 2 receipt) → where it lives
(screen 3 sidebar) → honesty (truth strip). ~60 seconds.

## Finalist 5-minute cut

Same order, but run the terminal governed loop live instead of frozen:

- 0:00–0:30 — frame (corporate card for AI agents) + dashboard title
- 0:30–1:30 — dashboard comparison: hard cap dies, governed delivers, dollars
- 1:30–3:00 — live terminal: create → work → final → finalize, narrate
  reserve/settle/protected reserve
- 3:00–4:00 — VS Code sidebar: same job, spend + risk live in the editor
- 4:00–4:30 — truth boundary + roadmap to Ramp finance side
- 4:30–5:00 — close on the dollar line: "$0.075 ceiling, $0.008 spent,
  review delivered and it passed."

## Fallbacks

- No API key by showtime → `npm run station:demo` (scripted provider, real
  ledger, real rate card, no key). Never called "live." See
  `station/rehearsal-server.ts`.
- Network dies → pre-captured screenshots of: dashboard comparison, terminal
  receipt, VS Code sidebar. Capture these before 2:30.
