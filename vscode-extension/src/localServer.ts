import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";

import {
  GovernorApiError,
  GovernorHttpClient,
  normalizeBaseUrl
} from "./apiClient";

const START_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 750;
const PROBE_INTERVAL_MS = 100;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;

export type ManagedServerTarget = {
  readonly baseUrl: string;
  readonly host: string;
  readonly port: number;
};

export type LocalServerStatus = "disabled" | "external" | "managed";

export function managedServerTarget(
  baseUrl: string
): ManagedServerTarget | null {
  const normalized = normalizeBaseUrl(baseUrl);
  const url = new URL(normalized);
  const hostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(hostname) ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    return null;
  }
  const port = url.port === "" ? 80 : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  return {
    baseUrl: normalized,
    host: hostname,
    port
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHealth(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).service === "token-governor" &&
    (value as Record<string, unknown>).status === "ready"
  );
}

export class LocalGovernorServer {
  readonly #serverPath: string;
  readonly #stateDirectory: string;
  readonly #log: (line: string) => void;
  #child: ManagedChild | undefined;
  #target: ManagedServerTarget | undefined;
  #operation: Promise<LocalServerStatus> | undefined;
  #disposed = false;

  constructor(options: {
    readonly serverPath: string;
    readonly stateDirectory: string;
    readonly log: (line: string) => void;
  }) {
    this.#serverPath = options.serverPath;
    this.#stateDirectory = options.stateDirectory;
    this.#log = options.log;
  }

  get ownsProcess(): boolean {
    return this.#child !== undefined;
  }

  ensureRunning(options: {
    readonly baseUrl: string;
    readonly enabled: boolean;
    readonly apiKey?: string;
  }): Promise<LocalServerStatus> {
    if (this.#operation) {
      return this.#operation;
    }
    const operation = this.#ensureRunning(options).finally(() => {
      if (this.#operation === operation) {
        this.#operation = undefined;
      }
    });
    this.#operation = operation;
    return operation;
  }

  async restart(options: {
    readonly baseUrl: string;
    readonly enabled: boolean;
    readonly apiKey?: string;
  }): Promise<LocalServerStatus> {
    const previous = this.#operation;
    const operation = (async () => {
      if (previous) {
        await previous.catch(() => undefined);
      }
      await this.stop();
      return this.#ensureRunning(options);
    })().finally(() => {
      if (this.#operation === operation) {
        this.#operation = undefined;
      }
    });
    this.#operation = operation;
    return operation;
  }

  async stop(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.#target = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const fallback = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      fallback.unref?.();
      child.once("exit", () => {
        clearTimeout(fallback);
        resolve();
      });
      child.kill();
    });
  }

  dispose(): void {
    this.#disposed = true;
    const child = this.#child;
    this.#child = undefined;
    this.#target = undefined;
    child?.kill();
  }

  async #ensureRunning(options: {
    readonly baseUrl: string;
    readonly enabled: boolean;
    readonly apiKey?: string;
  }): Promise<LocalServerStatus> {
    if (this.#disposed || !options.enabled) {
      await this.stop();
      return "disabled";
    }

    const target = managedServerTarget(options.baseUrl);
    if (!target) {
      await this.stop();
      return this.#disposed ? "disabled" : "external";
    }

    if (
      this.#target &&
      this.#target.baseUrl !== target.baseUrl &&
      this.#child
    ) {
      await this.stop();
      if (this.#disposed) return "disabled";
    }

    const initialProbe = await this.#probe(target.baseUrl);
    if (this.#disposed) return "disabled";
    if (initialProbe === "ready") {
      return this.#child ? "managed" : "external";
    }
    if (initialProbe === "occupied") {
      throw new GovernorApiError(
        `${target.baseUrl} is in use by a service that is not Governor.`,
        0,
        "LOCAL_PORT_OCCUPIED"
      );
    }

    if (this.#child) {
      this.#log("managed local server stopped responding; restarting it");
      await this.stop();
      if (this.#disposed) return "disabled";
    }

    if (!existsSync(this.#serverPath)) {
      throw new GovernorApiError(
        "The packaged Governor server is missing. Reinstall the extension.",
        0,
        "LOCAL_SERVER_MISSING"
      );
    }

    const env = { ...process.env };
    env.ELECTRON_RUN_AS_NODE = "1";
    env.HOST = target.host;
    env.PORT = String(target.port);
    env.GOVERNOR_STATE_DIR = this.#stateDirectory;
    if (options.apiKey?.trim()) {
      env.OPENAI_API_KEY = options.apiKey.trim();
    } else {
      delete env.OPENAI_API_KEY;
    }

    const child = spawn(process.execPath, [this.#serverPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    this.#child = child;
    this.#target = target;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#writeOutput(chunk));
    child.stderr.on("data", (chunk: string) => this.#writeOutput(chunk));
    child.once("exit", (code, signal) => {
      if (this.#child === child) {
        this.#child = undefined;
        this.#target = undefined;
      }
      this.#log(
        `local server stopped (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`})`
      );
    });
    child.once("error", (error) => {
      this.#log(`local server process error: ${error.message}`);
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.#disposed) return "disabled";
      if (child.exitCode !== null || child.signalCode !== null) {
        break;
      }
      const probe = await this.#probe(target.baseUrl);
      if (this.#disposed) return "disabled";
      if (probe === "ready") {
        this.#log(`managed local server ready at ${target.baseUrl}`);
        return "managed";
      }
      if (probe === "occupied") {
        await this.stop();
        if (this.#disposed) return "disabled";
        throw new GovernorApiError(
          `${target.baseUrl} became occupied by a service that is not Governor.`,
          0,
          "LOCAL_PORT_OCCUPIED"
        );
      }
      await delay(PROBE_INTERVAL_MS);
    }

    await this.stop();
    if (this.#disposed) return "disabled";
    throw new GovernorApiError(
      `The packaged Governor server did not start at ${target.baseUrl}.`,
      0,
      "LOCAL_SERVER_START_FAILED"
    );
  }

  async #probe(baseUrl: string): Promise<"ready" | "absent" | "occupied"> {
    const client = new GovernorHttpClient({
      baseUrl,
      timeoutMs: PROBE_TIMEOUT_MS
    });
    try {
      const health = await client.request("/api/health");
      return isHealth(health) ? "ready" : "occupied";
    } catch (error) {
      if (
        error instanceof GovernorApiError &&
        (error.code === "NETWORK_ERROR" || error.code === "TIMEOUT")
      ) {
        return "absent";
      }
      return "occupied";
    }
  }

  #writeOutput(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line !== "") {
        this.#log(`[server] ${line}`);
      }
    }
  }
}
