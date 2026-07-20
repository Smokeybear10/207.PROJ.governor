# Governor 207 for VS Code

**[Install Governor from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=governor.token-governor-vscode)**

Budget control for AI jobs inside the editor. The extension talks to the
Governor API (`/v1/jobs`) and shows spend, reservations, and risk live
while work runs through the governor. The local API is bundled in the VSIX and
starts automatically, so a Marketplace install does not require cloning this
repository or keeping a terminal process open.

## Overview

Requests sent through Governor follow a deterministic
**count → price → reserve → cap → dispatch → settle**
pipeline: it measures the exact input size, holds the worst-case cost
against a fixed budget, caps the output length, dispatches, then releases the
unused reservation. If a call can't fit the budget, it's refused cleanly
instead of overspending.

Workspace repair runs selected native Node tests against a disposable snapshot
of your source files. Approve a budget and the files sent to the model, review
the resulting diff, then apply it as unsaved editor changes. Tests and context
files remain read-only. A fresh snapshot verifies the patch; a passing test is
not proof against malicious code or incomplete test coverage.

## What it does

- **Status bar**: committed spend / budget for the active job, colored by the
  same risk thresholds the governor core uses (WATCH at 70% committed,
  AT_RISK at 90%).
- **Sidebar view**: a Governor icon in the Activity Bar opens a vertical
  job view with local-service and provider state, committed spend, a segmented
  budget bar, accounting metrics, and recent requests. **Repair Node tests**,
  **Review repair**, and **Run sample** are at the top; prompt controls sit under
  **Prompt jobs**. Scripted sample results show test checks, simulated cost,
  and an execution log. Workspace proposals open through **Review repair**.
  Works in VS Code and Cursor.
- **Commands** (Cmd+Shift+P, category "Governor"):
  - Health Check
  - Refresh Job View
  - Create Job (prompts for a USD budget, e.g. `0.075`)
  - Browse Saved Jobs (all jobs in the configured service, with spend and status)
  - View Saved Responses (read past results without dispatching again)
  - Export Job Report (Markdown or JSON accounting; excludes prompts and output)
  - Open Job View
  - Submit Selection Through Governor (sends the editor selection as the
    model input for a `work` or `final` response, after a cost preview)
  - Send Prompt Through Governor (type a prompt, it runs through the
    governed job, and the answer opens in a markdown tab beside your code
    with the token counts and reserved/settled cost at the top; offers to
    create a job if none is active; previews and enforces the approved cost ceiling)
  - Finalize Pending Response (accept/reject a settled final output)
  - Repair Workspace Test (select tests, editable source, context, and a budget)
  - Review Workspace Repair (reopen a saved run without another generation)
  - Run Sample CI Repair (always scripted, with no model call or charge)
  - Set OpenAI API Key / Clear OpenAI API Key (uses VS Code Secret Storage)

## Workspace repair

1. Open a trusted local package and run **Governor: Repair Workspace Test**.
2. Choose failing `node:test` files, up to 10 editable JavaScript/TypeScript
   files, and any read-only imports or `package.json` needed by those tests.
3. Approve the file list and total USD budget. Selected file contents and test
   output are sent to your configured model provider.
4. Open each proposed diff before applying. Governor refuses changes if any
   selected source, test, or context file changed while the repair ran.

Supported today: macOS, standalone Node 22.8+, native Node tests, and
self-contained JS/TS packages. No npm scripts, dependency installs, external
networking, or writes from test code. Snapshots are limited to 64 files,
64 KiB per file, and 128 KiB in total. Symlinks, dotfiles, and common credential
paths are excluded; inspect selected source for embedded credentials yourself.

Canceling the progress notification stops watching the approved run; it does
not submit another request. **Review Workspace Repair** reconnects to that run
and retains partial patches if it could not finish. The latest snapshot is
saved privately in workspace storage and may contain source code. Applying a
patch leaves files unsaved for review.

## Run it

These instructions cover source version 0.2.0. The
[Marketplace listing](https://marketplace.visualstudio.com/items?itemName=governor.token-governor-vscode)
still provides 0.1.0. [Build and install the VSIX](../docs/EXTENSION.md#install-the-packaged-build)
to use the features described here.

1. Install the packaged VSIX and reload the editor.
2. Open the Governor view: click the Governor icon in the Activity Bar, or run
   **Governor: Open Job View** from the Command Palette.
3. Click **Run sample** to watch a scripted repair, with no model call or charge.
   Its displayed cost is simulated. For a prompt job, use **Create Job** and
   choose a budget, such as `0.075`.
4. Before sending a prompt or editor selection, run **Governor: Set OpenAI API
   Key**. Then use **Send Prompt Through Governor** or **Submit Selection
   Through Governor** and watch the status bar update as Governor reserves,
   settles, and refuses requests that cannot fit.

The key is stored in VS Code Secret Storage and passed only to the managed
loopback service. Governor does not host a web application or remote API.

Jobs, spending, and saved responses survive editor reloads in the extension's
local storage. If the editor stops waiting after a prompt is dispatched, the
service finishes it and saves the result. **Open Saved Response** reads that
result without another generation. A service restart or uncertain provider
failure still holds the reserved budget; requests are never automatically retried.
Repair accounting is retained, but interrupted repair
execution does not resume. Saved responses may contain private code; API keys
are not stored with them.

Use **Saved jobs** to return to an earlier run and **Saved responses** to reopen
its output and cost. Neither needs an API key. The panel explains when a job is
closed, still running, waiting for review, or blocked by unresolved usage.

The repair demo requires macOS and standalone Node.js 22.8 or later on `PATH`.
Tests run with restricted file access and no writes, network, or subprocesses.
Repair refuses to run if that isolation is unavailable. Other extension
features do not depend on the repair runtime.

## Settings

- `tokenGovernor.apiBaseUrl` (default `http://127.0.0.1:8787`)
- `tokenGovernor.autoStartLocalServer` (default `true`)
- `tokenGovernor.requestTimeoutMs` (default `70000`)
- `tokenGovernor.pollIntervalMs` (default `2000`)
- `tokenGovernor.defaultFixtureId` (default `broken-sum`)

`tokenGovernor.providerMode` is deprecated. Editor samples always use scripted
responses; workspace repairs require the configured live provider.
