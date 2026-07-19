# Governor 207 for VS Code

**[Install Governor from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=governor.token-governor-vscode)**

Governor is a VS Code and Cursor extension for enforcing a dollar budget on
multi-step AI work. It was built at the Ramp Hackathon in New York City on
July 18, 2026.

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

Before each model call sent through it, Governor counts the proposed input,
reserves the request's conservative maximum cost, caps the output to the
remaining safe budget, dispatches once, and settles provider-reported usage.
A request that cannot fit is refused before it can spend.

The editor's **Run sample** action always uses scripted responses and synthetic
usage. It makes no model call or charge. Workspace repairs, typed prompts, and
editor selections use the configured live OpenAI provider and require an API key.

For direct sample API requests, the CI-repair workflow supports three modes:

- `fake`: deterministic scripted responses, with no network call or charge.
- `hybrid`: live input-token preflight with scripted generation.
- `live`: OpenAI generation using the service's configured API key.

## Extension features

- Activity Bar view with service/provider health, settled spend, reservations,
  remaining budget, and recent request status.
- Status bar risk indicator using the Governor core's `SAFE`, `WATCH`, and
  `AT_RISK` thresholds.
- Browse saved jobs across editor workspaces, with spending and status for each.
- Reopen saved responses without sending another model request.
- Preview exact input tokens, output limits, and maximum cost before sending.
- Enforce the approved per-request cost even if the next preflight changes.
- Export a spending report as Markdown or JSON without prompts or generated code.
- Send a typed prompt or editor selection through the governed API.
- Accept or reject a pending final response.
- See why a job is blocked, waiting for review, or ready for its final response.
- Repair selected workspace tests in an isolated copy, review the diff, and apply
  source changes as unsaved editor edits.
- Reopen a repair by its saved ID without starting another generation.

## Install and use

[Install Governor from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=governor.token-governor-vscode),
reload the editor, then open the Governor icon in the Activity Bar. The
packaged local service starts and stops with the extension.

This README describes the current source build. GitHub updates do not publish
to the Marketplace; use the build instructions below for these changes.

The scripted sample works without a key on the supported repair runtime. Before
repairing workspace tests or sending a prompt, run **Governor: Set OpenAI API Key**
from the Command Palette. The key is kept in VS Code Secret Storage and passed
only to the managed loopback service.

Prompts and selections show a cost preview before generation. Counting sends the
request to the configured provider, but does not generate an answer or reserve
money. Confirming sends it with the displayed cost ceiling; Governor recounts
and either fits the response inside that ceiling or refuses it.

For source development, `npm ci && npm start` still runs the local API
directly. Set `tokenGovernor.autoStartLocalServer` to `false` while using that
process.

## Repair a workspace test

In a local build, run **Governor: Repair Workspace Test**. Choose native Node
test files, editable source files, and read-only context, then approve the
snapshot and a $0.05–$20 budget. The selected code and test output go to the
configured model provider. Passing baselines and unsupported test setups stop
before model generation.

The first version supports self-contained JavaScript and erasable TypeScript
using `node:test` on macOS with standalone Node 22.8+. It does not install
dependencies, run npm scripts, or resolve TypeScript aliases. Snapshots are
limited to 64 files / 128 KiB, with at most 10 editable source files.

**Governor: Review Workspace Repair** reopens the latest proposal. Each changed
file has a diff; applying requires confirmation and refuses if any selected
source, test, or context file changed. Partial patches remain reviewable when
a run stops. Cancelling the progress notification stops watching; the approved
run continues. A service restart stops the run and preserves its last checkpoint
without retrying model calls.

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

`tokenGovernor.providerMode` is deprecated and does not change editor samples;
they always use scripted responses.

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

Repair comparison, without paid calls:

```bash
npm run benchmark:repair -- --smoke --output /tmp/governor-repair-smoke.json
```

The eight bundled cases are authored regressions with known scripted patches.
They test the harness, not model quality or savings. The live comparison uses
the same model, tasks, and final reserve in both arms: Governor's budget tools
and adjustable output cap versus a fixed cap without budget tools. Reports
include failed attempts, unresolved charges, task hashes, and cost per success.
Run `npm run benchmark:repair -- --help` for explicit live budget flags and an
external task manifest. No live benchmark or invoice comparison has been run.

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
scripted repair provider are implemented and tested. Jobs, spending, reservations,
response receipts, and final acceptance survive service and editor restarts.
The API accepts loopback
requests only and is not an authenticated multi-tenant service. The extension
is published on the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=governor.token-governor-vscode);
CI produces an installable VSIX on normal changes, while versioned
`vscode-v*` tags are the only Marketplace release trigger.

The managed extension saves jobs in its VS Code global storage directory.
Standalone `npm start` uses `~/.governor/jobs`; set `GOVERNOR_STATE_DIR` to
override it. Saved responses may contain private code, so keep that directory
private. API keys remain in Secret Storage and are not written to job files.
Only one service may write to a storage directory at a time.

Disconnecting during prompt preflight cancels it before generation. Once a
prompt has been dispatched, it finishes within the provider timeout and saves
its result even if the editor stops waiting. **Open Saved Response** retrieves
that result without another generation. Provider failures or a service restart
can still leave an uncertain outcome: Governor retains the full reservation
and never automatically retries. Reconciliation is not exposed by the current
HTTP or CLI surface.
Workspace repairs also save their latest patch and linked budget job in the
`repairs` subdirectory. Interrupted workflows do not resume automatically;
their saved patches remain unverified until checked again.

Repair execution requires macOS and standalone Node.js 22.8 or later. A native
sandbox limits reads to the fixture and runtime files and denies writes,
network access, and subprocesses. The runner refuses to execute if isolation
is unavailable; other platforms can still use governed prompts and reports.
This is not a VM or a complete resource sandbox, and passing tests is not proof
that generated code is trustworthy.

See [docs/GOVERNOR.md](docs/GOVERNOR.md) for the technical design,
[docs/CI_REPAIR.md](docs/CI_REPAIR.md) for the repair workflow, and
[docs/EXTENSION.md](docs/EXTENSION.md) for extension-specific notes.
