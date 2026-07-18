# Governor 207 Extension (VS Code / Cursor)

Live cockpit for the governor, inside the editor. Talks to the Governor
API (`/v1/jobs`, `/api/repair/runs`) and shows spend, reservations, and risk
live while work runs through the governor.

## UI

- **Status bar**: committed spend / budget for the active job, colored by the
  governor's risk thresholds (WATCH at 70% committed, AT_RISK at 90%).
- **Sidebar view** (Governor icon in the Activity Bar): committed-spend hero,
  budget bar (settled + reserved), accounting breakdown, and every submitted
  request with phase + status. A one-click toolbar drives all actions, and
  **CI-repair results render in-panel**: verdict, spend, sealed-evaluation
  checks, and the full governed trace. Works in VS Code and Cursor.
- **Commands** (Cmd+Shift+P, category "Governor"): Health Check · Create Job ·
  Set Active Job · Open Job View · Submit Selection Through Governor ·
  Finalize Pending Response · Run Governed CI-Repair.

## Try it locally

1. Start the API from the repo root: `npm start` (needs to stay running).
2. Open the Governor view: click the Governor icon, or run
   **Governor: Open Job View**.
3. Click **Run CI-Repair** — watch the verdict, spend (~$0.0045), and trace
   render live.

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
- `tokenGovernor.pollIntervalMs` (default `2000`)
- `tokenGovernor.defaultFixtureId` (default `broken-sum`)
- `tokenGovernor.providerMode` (`fake` | `hybrid` | `live`, default `fake`)

## Known dependency

The extension is a **client to a local governor server**. If nothing is
listening on `127.0.0.1:8787`, actions fail with a network error. Fix: run
`npm start`. **In progress:** the extension will auto-start the server on
activation so it's self-contained (no terminal needed).

## To publish to a marketplace (needs your accounts)

1. **Publisher identity** — VS Code Marketplace (Azure DevOps org + registered
   publisher; the package currently uses `publisher: "governor"`) **or**
   Open VSX (namespace + Eclipse account).
2. **Personal Access Token** (`VSCE_PAT`) — tied to your account; paste into a
   GitHub Actions secret or shell env. Never committed.
3. **Metadata** — confirm display name, a 128×128 PNG icon, repo URL, license.

Packaging + a CI `publish` job are already stubbed (`.github/workflows/extension.yml`,
`vscode-extension/scripts/mock-publish.mjs`); flip to real with `PUBLISH_REAL=true`
+ `VSCE_PAT`. The current deploy is a **mock** (`published: false`) — no live
marketplace URL exists yet.
