# Deploying `token-governor-vscode`

This extension (`governor.token-governor-vscode`) ships to the VS Code
Marketplace as a `.vsix` package. Day-to-day we use a **mock** publish so the
whole pipeline can run in CI without any Marketplace secret.

## Package the extension

Use Node.js 22 for extension build and test tooling.

```bash
npm run package
```

This compiles `src/**` → `out/**` and runs `vsce package --no-dependencies`,
producing `token-governor-vscode.vsix` in the extension root. What lands inside
the VSIX is controlled by [`.vscodeignore`](./.vscodeignore): the compiled
`out/**` JavaScript, `package.json`, `README.md`, and `media/**` are included;
TypeScript sources, tests, source maps, and tooling are excluded.

## Mock publish (default)

```bash
npm run publish:mock
```

This runs [`scripts/mock-publish.mjs`](./scripts/mock-publish.mjs), which:

1. Compiles and packages the extension (`npm run compile` then `npm run package`).
2. Locates the produced `.vsix` and reads its size plus name/version/publisher
   from `package.json`.
3. Prints a Marketplace-style receipt and writes a JSON receipt to
   `dist/mock-marketplace-receipt.json`:

   ```json
   {
     "name": "token-governor-vscode",
     "version": "0.1.0",
     "publisher": "governor",
     "vsix": "token-governor-vscode.vsix",
     "bytes": 12345,
     "published": false,
     "mode": "mock",
     "timestamp": "2026-07-18T00:00:00.000Z"
   }
   ```

No token is required and nothing is sent over the network. The script exits `0`
on success and non-zero with a clear message on failure (e.g. VSIX not found).

## Real publish

A real Marketplace publish is gated behind **two** environment variables so it
can never fire by accident:

```bash
PUBLISH_REAL=true VSCE_PAT=<marketplace-token> npm run publish:mock
```

When both `PUBLISH_REAL=true` and a `VSCE_PAT` [Personal Access
Token](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token)
are present, the script runs `vsce publish` against the packaged VSIX and
publishes to `https://marketplace.visualstudio.com/items?itemName=governor.token-governor-vscode`.
`vsce` reads `VSCE_PAT` from the environment, so the token is never passed on
the command line or echoed to logs. If `PUBLISH_REAL=true` is set but no
`VSCE_PAT` is available, the script safely falls back to a mock publish.

## CI

CI runs the extension test suite and, when the tests pass, automatically runs
`npm run publish:mock`. This proves the package builds and produces a valid
VSIX + receipt on every green build, without requiring a Marketplace secret.
