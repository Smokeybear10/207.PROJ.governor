# Governor 207 for VS Code

Governor is a VS Code and Cursor extension for enforcing a dollar budget on
multi-step AI work. It was built at the Ramp Hackathon in New York City on
July 18, 2026.

[Install Governor from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=governor.token-governor-vscode)

The extension keeps budget controls inside the editor. It creates governed
jobs, submits prompts or selected code, shows settled and reserved spend, warns
as a job approaches its limit, finalizes responses, and can run the governed
CI-repair workflow.

There is no hosted web application. The extension connects to the local
Governor service at `http://127.0.0.1:8787`.

## How it works

```text
VS Code extension
      |
      v
Local Express API
      |
      +--> governed jobs and CI-repair workflow
      |
      v
count -> price -> reserve -> cap -> dispatch -> settle
```

Before each model call, Governor counts the proposed input, reserves the
request's conservative maximum cost, caps the output to the remaining safe
budget, dispatches once, and settles provider-reported usage. A request that
cannot fit is refused before it can spend.

The local service supports three provider modes:

- `fake`: deterministic scripted responses, with no network call or charge.
- `hybrid`: live input-token preflight with scripted generation.
- `live`: OpenAI generation using `OPENAI_API_KEY`.

## Extension features

- Activity Bar view with settled spend, reservations, remaining budget, and
  request status.
- Status bar risk indicator using the Governor core's `SAFE`, `WATCH`, and
  `AT_RISK` thresholds.
- Create and select governed jobs without leaving the editor.
- Send a typed prompt or editor selection through the governed API.
- Accept or reject a pending final response.
- Run the sandboxed CI-repair workflow and inspect its sealed evaluation and
  governed trace.

## Run locally

The local service requires Node.js 18 or later:

```bash
npm ci
npm start
```

The default scripted provider is free and requires no API key. To exercise the
live provider, start the service with `OPENAI_API_KEY` set before creating a
job.

## Build and install the extension

The extension toolchain requires Node.js 22:

```bash
cd vscode-extension
npm ci
npm run package
code --install-extension token-governor-vscode.vsix --force
```

For Cursor, replace `code` with `cursor`. Reload the editor window after
installation, then open the Governor icon in the Activity Bar.

The extension settings are:

- `tokenGovernor.apiBaseUrl` (default `http://127.0.0.1:8787`)
- `tokenGovernor.pollIntervalMs` (default `2000`)
- `tokenGovernor.defaultFixtureId` (default `broken-sum`)
- `tokenGovernor.providerMode` (`fake`, `hybrid`, or `live`)

## Verify

Backend and enforcement engine:

```bash
npm run check
npm audit
```

VS Code extension, using Node.js 22:

```bash
cd vscode-extension
npm run typecheck
npm test
npm run test:vscode
npm run package
```

## Repository map

- `vscode-extension/`: the primary product surface.
- `server/governor/`: cost, ledger, reservation, retry, and risk policy.
- `server/runtime/`: count, reserve, dispatch, and settlement flow.
- `server/jobs/`: governed job lifecycle and accounting.
- `server/repair/`: sandboxed CI-repair workflow and sealed evaluator.
- `server/openai/`: scripted and OpenAI Responses API providers.
- `server/app.ts`: local API used by the extension.
- `cli/`: terminal access to the same local API.
- `tests/`: backend, API, workflow, and policy coverage.
- `docs/`: design, findings, and hackathon records.

## Current boundary

The enforcement kernel, local API, extension, CI-repair workflow, and scripted
provider are implemented and tested. Job state is process-local and is lost
when the service restarts. The local API is not an authenticated multi-tenant
service. The extension is published on the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=governor.token-governor-vscode);
CI produces an installable VSIX and performs a mock publish when publisher
credentials are absent.

See [docs/GOVERNOR.md](docs/GOVERNOR.md) for the technical design,
[docs/CI_REPAIR.md](docs/CI_REPAIR.md) for the repair workflow, and
[docs/EXTENSION.md](docs/EXTENSION.md) for extension-specific notes.
