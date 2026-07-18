#!/usr/bin/env node
// mock-publish.mjs — MOCK VS Code Marketplace deployment.
//
// This performs a full package build (compile + `vsce package`) and then a
// *mock* marketplace publish that requires no secrets and never touches the
// real Marketplace. A real publish only happens when BOTH VSCE_PAT is set and
// PUBLISH_REAL === "true".
//
// Usage:
//   node scripts/mock-publish.mjs            # mock deploy (default)
//   PUBLISH_REAL=true VSCE_PAT=xxx node ...  # real `vsce publish`

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// scripts/ lives directly under the extension root.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, "..");

const VSIX_NAME = "token-governor-vscode.vsix";
const VSIX_PATH = path.join(EXT_ROOT, VSIX_NAME);
const OUT_DIR = path.join(EXT_ROOT, "out");
const DIST_DIR = path.join(EXT_ROOT, "dist");
const RECEIPT_PATH = path.join(DIST_DIR, "mock-marketplace-receipt.json");

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function log(step, msg) {
  console.log(`\x1b[36m[deploy]\x1b[0m ${step} ${msg}`);
}
function ok(msg) {
  console.log(`\x1b[32m[deploy ✓]\x1b[0m ${msg}`);
}
function fail(msg, code = 1) {
  console.error(`\x1b[31m[deploy ✗]\x1b[0m ${msg}`);
  process.exit(code);
}

function run(cmd, args, label) {
  log(label, `→ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { cwd: EXT_ROOT, stdio: "inherit" });
  if (res.error) fail(`${label} failed to start: ${res.error.message}`);
  if (typeof res.status === "number" && res.status !== 0) {
    fail(`${label} exited with code ${res.status}`, res.status);
  }
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

console.log("──────────────────────────────────────────────");
console.log(" TokenGovernor — VS Code Marketplace deployment ");
console.log("──────────────────────────────────────────────");

// --- Read manifest -----------------------------------------------------------
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, "package.json"), "utf8"));
} catch (err) {
  fail(`could not read package.json: ${err.message}`);
}
const { name, version, publisher } = pkg;
if (!name || !version || !publisher) {
  fail("package.json is missing name/version/publisher");
}
const itemName = `${publisher}.${name}`;
const marketplaceUrl = `https://marketplace.visualstudio.com/items?itemName=${itemName}`;

// --- Step 1: build + package -------------------------------------------------
log("step 1/3", "compiling TypeScript (npm run compile)");
run(npmCmd, ["run", "compile"], "compile");
if (!fs.existsSync(OUT_DIR)) {
  fail(`compile did not produce ${path.relative(EXT_ROOT, OUT_DIR)}/`);
}
ok("compiled sources to out/");

log("step 1/3", "packaging VSIX (npm run package)");
run(npmCmd, ["run", "package"], "package");

// --- Step 2: locate + inspect the VSIX --------------------------------------
log("step 2/3", "locating packaged .vsix");
if (!fs.existsSync(VSIX_PATH)) {
  fail(`expected VSIX not found at ${VSIX_PATH}`);
}
const bytes = fs.statSync(VSIX_PATH).size;
ok(`found ${VSIX_NAME} (${humanBytes(bytes)})`);

// --- Step 3: publish (mock, unless explicitly real) --------------------------
const wantsReal = process.env.PUBLISH_REAL === "true";
const hasPat = Boolean(process.env.VSCE_PAT);

if (wantsReal && hasPat) {
  // REAL publish path. Not exercised in mock mode. `vsce` reads VSCE_PAT from
  // the environment, so no token is echoed to logs.
  log("step 3/3", `REAL publish → ${itemName}@${version}`);
  try {
    execFileSync(
      path.join(EXT_ROOT, "node_modules", ".bin", "vsce"),
      ["publish", "--no-dependencies", "--packagePath", VSIX_PATH],
      { cwd: EXT_ROOT, stdio: "inherit" },
    );
  } catch (err) {
    fail(`real publish failed: ${err.message}`);
  }
  ok(`published ${itemName}@${version} to the Marketplace`);
  ok(marketplaceUrl);
  process.exit(0);
}

// MOCK publish path (default).
if (wantsReal && !hasPat) {
  log("step 3/3", "PUBLISH_REAL=true but VSCE_PAT is unset → falling back to MOCK");
}
log("step 3/3", "MOCK marketplace publish (no secrets, no network)");

const timestamp = new Date().toISOString();
const receipt = {
  name,
  version,
  publisher,
  vsix: path.relative(EXT_ROOT, VSIX_PATH),
  bytes,
  published: false,
  mode: "mock",
  timestamp,
};

fs.mkdirSync(DIST_DIR, { recursive: true });
fs.writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

console.log("");
console.log("╔══════════════════ MARKETPLACE RECEIPT (MOCK) ══════════════════");
console.log(`║ extension : ${itemName}@${version}`);
console.log(`║ publisher : ${publisher}`);
console.log(`║ vsix      : ${receipt.vsix} (${humanBytes(bytes)})`);
console.log(`║ url       : ${marketplaceUrl}`);
console.log(`║ published : false (mock — set PUBLISH_REAL=true + VSCE_PAT to publish)`);
console.log(`║ time      : ${timestamp}`);
console.log("╚═════════════════════════════════════════════════════════════════");
console.log("");

ok(`wrote receipt → ${path.relative(EXT_ROOT, RECEIPT_PATH)}`);
ok("mock deployment complete");
process.exit(0);
