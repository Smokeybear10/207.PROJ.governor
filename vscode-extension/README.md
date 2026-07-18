# Governor 207 for VS Code

[Install Governor from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=governor.token-governor-vscode)

Budget control for AI jobs inside the editor. The extension talks to the
Governor API (`/v1/jobs`) and shows spend, reservations, and risk live
while work runs through the governor. The local API is bundled in the VSIX and
starts automatically, so a Marketplace install does not require cloning this
repository or keeping a terminal process open.

## Overview

Governor is a spend firewall for AI agents. Every model call is routed
through a deterministic **count → price → reserve → cap → dispatch → settle**
pipeline: it measures the exact input size for free, holds the worst-case cost
against a fixed budget, caps the output length, dispatches, then refunds the
unused reservation. If a call can't fit the budget, it's refused cleanly
instead of overspending.

This extension is the live cockpit for that engine. It also drives a **governed
CI-repair agent**: point it at a broken repo fixture and it reads the failing
tests, proposes patches through sandboxed tools, re-runs the suite, and stops
the moment the build is green or the budget is exhausted — with an independent,
sealed evaluator confirming the fix in a fresh checkout so success can't be
gamed.

## What it does

- **Status bar**: committed spend / budget for the active job, colored by the
  same risk thresholds the governor core uses (WATCH at 70% committed,
  AT_RISK at 90%).
- **Sidebar view**: a Governor icon in the Activity Bar opens a vertical
  job view with local-service and provider state, committed spend, a segmented
  budget bar, accounting metrics, and recent requests. Grouped job controls
  keep the primary repair and prompt actions clear, while refresh, new-job,
  and API-key actions also live in the native view title. CI-repair results
  (verdict, spend, sealed-evaluation checks, and the governed trace) render in
  the panel. Sits
  alongside the file explorer like Copilot does; works in VS Code and Cursor.
- **Commands** (Cmd+Shift+P, category "Governor"):
  - Health Check
  - Refresh Job View
  - Create Job (prompts for a USD budget, e.g. `0.075`)
  - Set Active Job
  - Open Job View
  - Submit Selection Through Governor (sends the editor selection as the
    model input for a `work` or `final` response)
  - Send Prompt Through Governor (type a prompt, it runs through the
    governed job, and the answer opens in a markdown tab beside your code
    with the token counts and reserved/settled cost at the top; offers to
    create a job if none is active)
  - Finalize Pending Response (accept/reject a settled final output)
  - Run Governed CI-Repair (runs the repair agent on a fixture under budget)
  - Set OpenAI API Key / Clear OpenAI API Key (uses VS Code Secret Storage)

## How it saves money

The governor bakes in a set of cost-control tactics. Implemented today:

- ✅ **Count before you call** — measure the exact size of each request for
  free, so we never overpay on a guess.
- ✅ **Set money aside, then refund** — hold the max a call could cost, then
  give back whatever it didn't use.
- ✅ **Cap the answer length** — limit how much the model can write so a reply
  can't blow the budget.
- ✅ **Don't repeat dead-end work** — if nothing changed, block the agent from
  running the same failing step again.
- ✅ **Shrink giant logs** — cut a huge test log down to just the lines that
  explain the failure.
- ✅ **Reuse instead of resend** — when a result is identical to last time,
  point back to it (content-addressed artifacts) instead of paying twice.
- ✅ **Always keep enough to finish** — reserve budget so the agent can deliver
  a final answer instead of running out mid-task.
- ✅ **Quit while you're ahead** — refuse calls that won't fit the budget and
  stop cleanly instead of wasting money.
- ✅ **Use the cheapest model that works** — default to the low-cost model and
  only upgrade when we truly need to.

On the roadmap:

- ◻ **Only run the tests that matter** — run the tests a change could break,
  not the whole suite.
- ◻ **Look before you read** — guess where the bug is and read just those
  lines, not the whole file.
- ◻ **Ignore unreliable tests** — don't waste tries "fixing" tests that
  randomly fail on their own.

## Run it

1. Install Governor from the Marketplace and reload the editor.
2. Open the Governor view: click the Governor icon in the Activity Bar, or run
   **Governor: Open Job View** from the Command Palette.
3. Click **Run CI-Repair** to watch a governed repair run end to end, or
   **Create Job** → budget `0.075`. The default repair run is deterministic and
   makes no network call.
4. Before sending a prompt or editor selection, run **Governor: Set OpenAI API
   Key**. Then use **Send Prompt Through Governor** or **Submit Selection
   Through Governor** and watch the status bar update as Governor reserves,
   settles, and refuses requests that cannot fit.

The key is stored in VS Code Secret Storage and passed only to the managed
loopback service. Governor does not host a web application or remote API.

## Settings

- `tokenGovernor.apiBaseUrl` (default `http://127.0.0.1:8787`)
- `tokenGovernor.autoStartLocalServer` (default `true`)
- `tokenGovernor.requestTimeoutMs` (default `70000`)
- `tokenGovernor.pollIntervalMs` (default `2000`)
- `tokenGovernor.defaultFixtureId` (default `broken-sum`)
- `tokenGovernor.providerMode` (`fake` | `hybrid` | `live`, default `fake`)
