# Governor 207 for VS Code

Governor is a VS Code and Cursor extension for enforcing a dollar budget on
multi-step AI work. It was built at the Ramp Hackathon in New York City on
July 18, 2026.

[Install Governor from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=governor.token-governor-vscode)

The extension keeps budget controls inside the editor. It creates governed
jobs, submits prompts or selected code, shows settled and reserved spend, warns
as a job approaches its limit, finalizes responses, and can run the governed
CI-repair workflow. Its loopback-only service is bundled in the extension and
starts automatically; installing the Marketplace extension does not require a
repository clone or a separate terminal process.

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

The CI-repair workflow supports three provider modes:

- `fake`: deterministic scripted responses, with no network call or charge.
- `hybrid`: live input-token preflight with scripted generation.
- `live`: OpenAI generation using an API key stored in VS Code Secret Storage.

Typed prompts and editor selections use the live OpenAI provider and fail
closed until an API key is configured.

## Extension features

- Activity Bar view with service/provider health, settled spend, reservations,
  remaining budget, and recent request status.
- Status bar risk indicator using the Governor core's `SAFE`, `WATCH`, and
  `AT_RISK` thresholds.
- Create and select governed jobs without leaving the editor.
- Send a typed prompt or editor selection through the governed API.
- Accept or reject a pending final response.
- Run the sandboxed CI-repair workflow and inspect its sealed evaluation and
  governed trace.

## Install and use

[Install Governor from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=governor.token-governor-vscode),
reload the editor, then open the Governor icon in the Activity Bar. The
packaged local service starts and stops with the extension.

The deterministic CI-repair demo works immediately without a key. Before
sending a typed prompt or selected code, run **Governor: Set OpenAI API Key**
from the Command Palette. The key is kept in VS Code Secret Storage and passed
only to the managed loopback service.

For source development, `npm ci && npm start` still runs the local API
directly. Set `tokenGovernor.autoStartLocalServer` to `false` while using that
process.

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
- `tokenGovernor.autoStartLocalServer` (default `true`)
- `tokenGovernor.requestTimeoutMs` (default `70000`)
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

The enforcement kernel, managed local API, extension, CI-repair workflow, and
scripted repair provider are implemented and tested. Job state is process-local
and is lost when the service or editor restarts. The API accepts loopback
requests only and is not an authenticated multi-tenant service. The extension
is published on the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=governor.token-governor-vscode);
CI produces an installable VSIX on normal changes, while versioned
`vscode-v*` tags are the only Marketplace release trigger.

See [docs/GOVERNOR.md](docs/GOVERNOR.md) for the technical design,
[docs/CI_REPAIR.md](docs/CI_REPAIR.md) for the repair workflow, and
[docs/EXTENSION.md](docs/EXTENSION.md) for extension-specific notes.
