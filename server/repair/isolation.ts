import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const runtimeSchema = z.object({
  version: z.string(),
  executable: z.string(),
  libraries: z.array(z.string()).max(2_000)
}).strict();

type NodeRuntime = { executable: string; libraries: readonly string[] };
export type IsolatedTestCommand = {
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
};
let runtimePromise: Promise<NodeRuntime> | undefined;

export class RepairIsolationError extends Error {
  readonly code = "REPAIR_ISOLATION_UNAVAILABLE";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepairIsolationError";
  }
}

function cleanEnvironment(dir: string): NodeJS.ProcessEnv {
  return { PATH: "", HOME: dir, TMPDIR: dir, NODE_OPTIONS: "", OPENSSL_CONF: "/dev/null" };
}

async function findNode(): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
    const candidate = join(directory, "node");
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new RepairIsolationError("CI repair requires standalone Node.js 22.8 or newer on PATH. The editor's Electron runtime cannot run isolated tests.");
}

async function inspectRuntime(): Promise<NodeRuntime> {
  if (process.platform !== "darwin") {
    throw new RepairIsolationError("CI repair currently requires macOS execution isolation. This platform has no supported isolated runner; host execution is disabled.");
  }
  try {
    await access(SANDBOX_EXEC, constants.X_OK);
    const executable = await findNode();
    // This fixed bootstrap inspects the trusted Node runtime; it never loads fixture code.
    const { stdout } = await execute(executable, ["-e", "process.stdout.write(JSON.stringify({version:process.versions.node,executable:process.execPath,libraries:process.report.getReport().sharedObjects}))"], {
      cwd: "/", env: cleanEnvironment("/"), encoding: "utf8", timeout: 5_000, maxBuffer: 256 * 1024
    });
    const runtime = runtimeSchema.parse(JSON.parse(stdout) as unknown);
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(runtime.version);
    if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 8)) {
      throw new RepairIsolationError("CI repair requires standalone Node.js 22.8 or newer for tests without subprocesses.");
    }
    if (await realpath(runtime.executable) !== executable) {
      throw new RepairIsolationError("The isolated Node runtime did not match the selected executable.");
    }
    const libraries = new Set([executable]);
    for (const library of runtime.libraries) {
      if (!isAbsolute(library)) throw new RepairIsolationError("Node reported a non-absolute runtime library.");
      if (library.startsWith("/System/") || library.startsWith("/usr/lib/")) continue;
      libraries.add(await realpath(library));
    }
    return { executable, libraries: [...libraries] };
  } catch (error) {
    if (error instanceof RepairIsolationError) throw error;
    throw new RepairIsolationError("CI repair could not initialize macOS isolation. Check that sandbox-exec and standalone Node.js 22.8 or newer are available. Host execution is disabled.", { cause: error });
  }
}

function runtime(): Promise<NodeRuntime> {
  if (!runtimePromise) {
    runtimePromise = inspectRuntime().catch((error: unknown) => {
      runtimePromise = undefined;
      throw error;
    });
  }
  return runtimePromise;
}

function profile(dir: string, node: NodeRuntime): string {
  const literals = node.libraries.map((path) => `(literal ${JSON.stringify(path)})`).join(" ");
  const ancestors = [...node.libraries, dir].map((path) => `(path-ancestors ${JSON.stringify(path)})`).join(" ");
  return [
    "(version 1)", "(deny default)",
    `(allow process-exec (literal ${JSON.stringify(node.executable)}))`,
    "(allow sysctl-read)",
    `(allow file-read-metadata ${ancestors} (subpath "/opt/homebrew") (subpath "/usr/local"))`,
    `(allow file-read* file-map-executable (subpath \"/System/Library\") (subpath \"/usr/lib\") ${literals})`,
    // libignition opens the root directory to resolve runtime libraries with openat.
    `(allow file-read* (literal \"/\") (subpath ${JSON.stringify(dir)}) (literal \"/dev/random\") (literal \"/dev/urandom\"))`,
    "(allow file-read* file-write* (literal \"/dev/null\"))"
  ].join("\n");
}

export async function prepareIsolatedTests(dir: string, command: readonly string[]): Promise<IsolatedTestCommand> {
  const tests = command.slice(2);
  if (command.length < 2 || command[0] !== "node" || command[1] !== "--test" ||
    tests.length > 64 || new Set(tests).size !== tests.length ||
    !tests.every((path) => path.length <= 240 && /\.(?:[cm]?js|[cm]?ts)$/.test(path) &&
      path.split("/").every((part) => /^[a-zA-Z0-9_][a-zA-Z0-9_. -]*$/.test(part)))) {
    throw new RepairIsolationError("Isolated repair supports only the pinned node --test command.");
  }
  const node = await runtime();
  const root = await realpath(dir);
  for (const path of tests) {
    let current = root;
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]);
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory())) {
        throw new RepairIsolationError("Selected tests must be regular files inside the snapshot.");
      }
    }
  }
  const args = ["-p", profile(root, node), node.executable];
  const env = cleanEnvironment(root);
  try {
    const { stdout } = await execute(SANDBOX_EXEC, [...args, "-e", "process.stdout.write('governor-isolation-ready')"], {
      cwd: root, env, encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024
    });
    if (stdout !== "governor-isolation-ready") throw new Error("Unexpected isolation probe output.");
  } catch (error) {
    throw new RepairIsolationError("The isolated Node test runner failed its startup check. No repair code was executed; host execution is disabled.", { cause: error });
  }
  return {
    executable: SANDBOX_EXEC,
    args: [...args, "--test", "--test-reporter=tap", "--experimental-test-isolation=none", "--experimental-strip-types", "--max-old-space-size=256", ...tests.map((path) => `./${path}`)],
    env
  };
}
