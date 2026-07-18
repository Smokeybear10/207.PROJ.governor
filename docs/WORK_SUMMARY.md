# Governor 207 - Work Summary

Governor 207 is a VS Code and Cursor extension backed by a local budget-control
service. It enforces a deterministic
`count -> price -> reserve -> cap -> dispatch -> settle` pipeline around every
model call.

## Product surface

1. **VS Code extension** (`vscode-extension/`) - job controls, spend and risk
   status, prompt submission, response finalization, and CI-repair results.
2. **Local API** (`server/app.ts`) - health, governed jobs, and CI-repair
   routes used by the extension.
3. **Repair workflow** (`server/repair/`) - sandboxed repair tools and a sealed
   evaluator.
4. **Governor service** (`server/jobs/`, `server/runtime/`,
   `server/governor/`) - the single spend authority.

The project does not ship or host a website. Web-only frontend and deployment
code are not part of the extension deliverable.

## Implemented

- Deterministic per-job dollar budgets with conservative reservation.
- Output caps and explicit settlement from provider-reported usage.
- Retry suppression, bounded log reduction, and content-addressed artifacts.
- VS Code Activity Bar view, status bar risk state, and governed commands.
- Sandboxed CI-repair with allowlisted edits and isolated final evaluation.
- Scripted, hybrid, and live provider modes.
- Installable VSIX packaging and extension CI.

## Run

```bash
npm start
```

Then install or launch the extension from `vscode-extension/`. The extension
connects to `http://127.0.0.1:8787` by default.

## Verification

```bash
npm run check
cd vscode-extension
npm run typecheck
npm test
npm run test:vscode
npm run package
```
