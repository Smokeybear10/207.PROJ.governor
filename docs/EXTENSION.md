# Governor 207 Extension (VS Code / Cursor)

Live cockpit for the governor, inside the editor. Talks to the Governor
API (`/v1/jobs`, `/api/repair/runs`) and shows spend, reservations, and risk
live while work runs through the governor.

[Install Governor from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=governor.token-governor-vscode)

The VSIX contains the local Governor service. For the default loopback URL, the
extension starts and stops that service automatically.

## UI

- **Status bar**: committed spend / budget for the active job, colored by the
  governor's risk thresholds (WATCH at 70% committed, AT_RISK at 90%).
- **Sidebar view** (Governor icon in the Activity Bar): committed-spend hero,
  segmented budget bar (settled + reserved), accounting breakdown, and recent
  requests with phase + status. Service and provider state stay visible,
  controls are grouped by workflow, and refresh, new-job, and API-key actions
  use the native view title. **CI-repair results render in-panel**: verdict,
  spend, sealed-evaluation checks, and the governed trace. Works in VS Code
  and Cursor.
- **Commands** (Cmd+Shift+P, category "Governor"): Health Check · Refresh Job
  View · Create Job · Set Active Job · Open Job View · Submit Selection
  Through Governor · Send Prompt Through Governor · Finalize Pending Response
  · Run Governed CI-Repair · Set/Clear OpenAI API Key.

## Try it locally

1. Install the Marketplace extension and reload the editor.
2. Open the Governor view: click the Governor icon, or run
   **Governor: Open Job View**.
3. Click **Run CI-Repair** — watch the verdict, spend (~$0.0045), and trace
   render live. The deterministic repair mode requires no API key.
4. To send prompts or selections through OpenAI, run
   **Governor: Set OpenAI API Key**. The key is stored in VS Code Secret
   Storage and the managed service restarts with it.

## Install the packaged build

Building the extension requires Node.js 22.

```bash
cd vscode-extension
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
- `tokenGovernor.providerMode` (`fake` | `hybrid` | `live`, default `fake`)

## Local boundary

The packaged server binds only to loopback and rejects non-loopback Host
headers and browser-origin requests. Job state remains in memory, so restarting
the managed service clears prior jobs; the extension detects and removes those
stale job IDs. A custom API URL or `autoStartLocalServer: false` leaves process
management to the user.

## Marketplace releases

The extension is live under publisher `governor`. CI tests and packages normal
changes without publishing them. A tag matching the manifest version, such as
`vscode-v0.2.0`, is the only automatic Marketplace release trigger and requires
the repository `VSCE_PAT` secret.
