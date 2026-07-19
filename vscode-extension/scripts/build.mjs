#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const repositoryRoot = path.resolve(extensionRoot, "..");
const outDir = path.join(extensionRoot, "out");
const executableSuffix = process.platform === "win32" ? ".cmd" : "";

rmSync(outDir, { force: true, recursive: true });
mkdirSync(outDir, { recursive: true });

execFileSync(
  path.join(
    extensionRoot,
    "node_modules",
    ".bin",
    `tsc${executableSuffix}`
  ),
  ["-p", extensionRoot],
  { cwd: extensionRoot, stdio: "inherit" }
);

await build({
  absWorkingDir: extensionRoot,
  // Keep the bundle tied to this package's lockfile even when the repository
  // root also has compatible backend dependencies installed.
  alias: {
    express: path.join(extensionRoot, "node_modules", "express", "index.js"),
    "proper-lockfile": path.join(extensionRoot, "node_modules", "proper-lockfile", "index.js"),
    zod: path.join(extensionRoot, "node_modules", "zod", "index.js")
  },
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
  },
  bundle: true,
  entryPoints: [path.join(repositoryRoot, "server", "main.ts")],
  format: "esm",
  legalComments: "none",
  nodePaths: [path.join(extensionRoot, "node_modules")],
  outfile: path.join(outDir, "governor-server.mjs"),
  platform: "node",
  target: "node18"
});

cpSync(
  path.join(repositoryRoot, "server", "repair", "fixtures"),
  path.join(outDir, "fixtures"),
  { recursive: true }
);
