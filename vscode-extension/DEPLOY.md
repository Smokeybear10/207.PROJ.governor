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
extension, bundled local server, repair fixture, `package.json`, `README.md`,
and `media/**` are included; TypeScript sources, build tests, source maps, and
tooling are excluded.

## Mock publish (default)

```bash
npm run publish:mock
```

This runs [`scripts/mock-publish.mjs`](./scripts/mock-publish.mjs), which:

1. Builds and packages the extension (`npm run package`).
2. Locates the produced `.vsix` and reads its size plus name/version/publisher
   from `package.json`.
3. Prints a Marketplace-style receipt and writes a JSON receipt to
   `dist/mock-marketplace-receipt.json`:

   ```json
   {
     "name": "token-governor-vscode",
     "version": "0.2.0",
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
`VSCE_PAT` is available, the script fails without publishing.

## CI

Normal pushes run backend checks, extension unit tests, the real VS Code host
suite, dependency audits, and VSIX packaging. They upload the tested VSIX but
never publish it.

Marketplace publication requires a tag matching the extension version:

```bash
git tag vscode-v0.2.0
git push origin vscode-v0.2.0
```

The release job rejects a tag that does not match `package.json`, and fails if
the repository `VSCE_PAT` secret is missing. This prevents duplicate or
accidental Marketplace publishes from ordinary pushes.
