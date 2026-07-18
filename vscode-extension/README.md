# TokenGovernor for VS Code

Budget control for AI jobs inside the editor. The extension talks to the
TokenGovernor API (`/v1/jobs`) and shows spend, reservations, and risk live
while work runs through the governor.

## What it does

- **Status bar**: committed spend / budget for the active job, colored by the
  same risk thresholds the governor core uses (WATCH at 70% committed,
  AT_RISK at 90%).
- **Job panel**: budget bar (settled + reserved), accounting breakdown, and
  every submitted request with its phase and status, so you can see which
  steps to look into.
- **Commands** (Cmd+Shift+P, category "Governor"):
  - Health Check
  - Create Job (prompts for a USD budget, e.g. `0.075`)
  - Set Active Job
  - Open Job Panel
  - Submit Selection Through Governor (sends the editor selection as the
    model input for a `work` or `final` response)
  - Finalize Pending Response (accept/reject a settled final output)

## Run it (demo)

1. Start the governor server from the repo root:

   ```bash
   npm start                      # scripted provider
   OPENAI_API_KEY=... npm start   # live OpenAI calls
   ```

2. Open the `vscode-extension/` folder in VS Code:

   ```bash
   cd vscode-extension
   npm install
   npm run compile
   code .
   ```

3. Press F5 to launch the Extension Development Host.
4. In the dev host: "Governor: Create Job" → budget `0.075` → open the job
   panel, select some text in any file, then "Governor: Submit Selection
   Through Governor". Watch the status bar and panel update as the governor
   reserves, settles, and (when over budget) refuses requests.

## Settings

- `tokenGovernor.apiBaseUrl` (default `http://127.0.0.1:8787`)
- `tokenGovernor.pollIntervalMs` (default `2000`)
