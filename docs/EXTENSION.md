# Governor 207 Extension (VS Code / Cursor)

Budget control inside the editor. Talks to the Governor API (`/v1/jobs`,
`/api/repair/runs`, `/api/repair/repository/runs`) and shows spend, reservations,
and risk while work runs through Governor.

[Install Governor from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=governor.token-governor-vscode)

The VSIX contains the local Governor service. For the default loopback URL, the
extension starts and stops that service automatically.

## UI

- **Status bar**: committed spend / budget for the active job, colored by the
  governor's risk thresholds (WATCH at 70% committed, AT_RISK at 90%).
- **Sidebar view** (Governor icon in the Activity Bar): committed spend,
  segmented budget bar (settled + reserved), accounting breakdown, and recent
  requests with phase + status. Service and provider state stay visible,
  controls are grouped by workflow, and refresh, new-job, and API-key actions
  use the native view title. **Scripted sample results render in-panel**: test
  checks, simulated cost, and an execution log. **Review repair** opens workspace
  proposals as diffs. Works in VS Code and Cursor.
- **Commands** (Cmd+Shift+P, category "Governor"): Health Check · Refresh Job
  View · Create Job · Browse Saved Jobs · View Saved Responses · Export Job Report · Open Job View · Submit Selection
  Through Governor · Send Prompt Through Governor · Finalize Pending Response
  · Repair Workspace Test · Review Workspace Repair · Run Sample CI Repair
  · Set/Clear OpenAI API Key.

## Try it locally

1. Build and install the current VSIX using the instructions below, then reload
   the editor. GitHub updates do not automatically publish a Marketplace release.
2. Open the Governor view: click the Governor icon, or run
   **Governor: Open Job View**.
3. Click **Run sample** to see the scripted test result, simulated cost, and
   execution log. Samples always run without a model call or charge.
4. To send prompts or selections through OpenAI, run
   **Governor: Set OpenAI API Key**. The key is stored in VS Code Secret
   Storage and the managed service restarts with it.
5. Send a prompt or selection, review its token count and maximum cost, then
   confirm. Declining the preview does not dispatch generation or reserve funds.
6. Use **Export Job Report** to save Markdown or JSON accounting without
   prompt or response content. This works without an API key, including for
   completed or unresolved jobs.

## Install the packaged build

Building the extension requires Node.js 22.

```bash
cd vscode-extension
npm ci
npm run package     # -> token-governor-vscode.vsix
# Cursor:
cursor --install-extension token-governor-vscode.vsix --force
# VS Code:
code --install-extension token-governor-vscode.vsix --force
```

Then reload the window (Cmd+Shift+P → Developer: Reload Window).

## Settings

- `tokenGovernor.apiBaseUrl` (default `http://127.0.0.1:8787`)
- `tokenGovernor.autoStartLocalServer` (default `true`)
- `tokenGovernor.requestTimeoutMs` (default `70000`)
- `tokenGovernor.pollIntervalMs` (default `2000`)
- `tokenGovernor.defaultFixtureId` (default `broken-sum`)

`tokenGovernor.providerMode` is deprecated and ignored by editor samples.
Workspace repairs require the configured live provider.

## Local boundary

The packaged server binds only to loopback and rejects non-loopback Host
headers and browser-origin requests. Jobs and response receipts are saved under
`globalStorageUri/jobs`, including spending, reservations, and final acceptance.
The selected job survives reloads. A custom API URL or
`autoStartLocalServer: false` leaves process management to the user; the standalone
server uses `GOVERNOR_STATE_DIR` or `~/.governor/jobs`.

**Saved jobs** browses the configured service's history, including jobs from
other workspaces. **Saved responses** opens a stored result and its accounting
without an API key or a new model call. Original prompts are not stored.
Closed, running, and unresolved jobs disable new submissions; pending final
responses must be reviewed before acceptance or rejection.

Cost previews use provider token counting and the same admission rules as actual
requests. They reserve no money and can become stale; submission recounts and
enforces both the job budget and the approved per-request ceiling. If fewer
tokens fit, the output cap shrinks. If the useful minimum no longer fits, no
generation is dispatched. Reports are local accounting records at pinned rates,
not provider invoices or tamperproof attestations.

Storage permits one writer at a time and stops spending if a write fails. A
client disconnect cancels a prompt that is still counting tokens. After
dispatch, generation continues within its existing output cap and provider
timeout, and the result is saved. An interrupted submission offers **Open Saved
Response**, which reads the original job and request without resending it.
If it is still running, check saved responses again later.

A provider request interrupted by a restart keeps its full reserved cost and
requires reconciliation; Governor does not resend it. The HTTP API does not yet
offer reconciliation. CI-repair accounting is retained, but temporary sandboxes,
tool state, and repair execution do not resume automatically. Saved response
content is local private data; API keys are not included.

CI repair requires macOS and standalone Node.js 22.8 or later on `PATH`. Both
test runs and final verification use the native sandbox; there is no
unrestricted fallback. Governed prompts, saved jobs, and reports do not require
this repair runtime.

## Marketplace releases

The extension is live under publisher `governor`. CI tests and packages normal
changes without publishing them. A tag matching the manifest version, such as
`vscode-v0.2.0`, is the only automatic Marketplace release trigger and requires
the repository `VSCE_PAT` secret.
