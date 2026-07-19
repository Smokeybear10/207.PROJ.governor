import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalGovernorServer, managedServerTarget } from "./localServer";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: () => true }));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function managedChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
      return true;
    })
  });
  return child;
}

function localServer() {
  return new LocalGovernorServer({
    serverPath: "/extension/out/governor-server.mjs",
    stateDirectory: "/user data/governor/jobs",
    log: vi.fn()
  });
}

function healthyResponse(): Response {
  return new Response(JSON.stringify({ service: "token-governor", status: "ready" }));
}

describe("managedServerTarget", () => {
  it("accepts loopback HTTP endpoints", () => {
    expect(managedServerTarget("http://127.0.0.1:8787/")).toEqual({
      baseUrl: "http://127.0.0.1:8787",
      host: "127.0.0.1",
      port: 8787
    });
    expect(managedServerTarget("http://[::1]:9000")).toEqual({
      baseUrl: "http://[::1]:9000",
      host: "::1",
      port: 9000
    });
  });

  it.each([
    "https://127.0.0.1:8787",
    "http://192.0.2.10:8787",
    "http://localhost:8787/api"
  ])("does not manage custom endpoint %s", (value) => {
    expect(managedServerTarget(value)).toBeNull();
  });
});

describe("LocalGovernorServer storage", () => {
  it("keeps the extension storage directory across restarts and reloads", async () => {
    let running = false;
    vi.stubEnv("GOVERNOR_STATE_DIR", "/unrelated/inherited-state");
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (!running) {
        throw new TypeError("Service unavailable");
      }
      return new Response(JSON.stringify({
        service: "token-governor",
        status: "ready"
      }));
    }));
    vi.mocked(spawn).mockImplementation(() => {
      running = true;
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null as NodeJS.Signals | null,
        kill: () => {
          running = false;
          child.signalCode = "SIGTERM";
          child.emit("exit", null, "SIGTERM");
          return true;
        }
      });
      return child as unknown as ReturnType<typeof spawn>;
    });

    const constructorOptions = {
      serverPath: "/extension/out/governor-server.mjs",
      stateDirectory: "/user data/governor/jobs",
      log: vi.fn()
    };
    const serverOptions = {
      baseUrl: "http://127.0.0.1:8787",
      enabled: true
    };
    const server = new LocalGovernorServer(constructorOptions);
    await expect(server.ensureRunning(serverOptions)).resolves.toBe("managed");
    await expect(server.restart(serverOptions)).resolves.toBe("managed");
    server.dispose();

    const reloaded = new LocalGovernorServer(constructorOptions);
    await expect(reloaded.ensureRunning(serverOptions)).resolves.toBe("managed");
    await reloaded.stop();

    expect(spawn).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(spawn).mock.calls) {
      expect(call).toEqual([
        process.execPath,
        [constructorOptions.serverPath],
        expect.objectContaining({
          env: expect.objectContaining({
            GOVERNOR_STATE_DIR: constructorOptions.stateDirectory
          })
        })
      ]);
    }
  });

  it("does not start a second writer when Governor already serves the URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      service: "token-governor",
      status: "ready"
    }))));
    const server = new LocalGovernorServer({
      serverPath: "/extension/out/governor-server.mjs",
      stateDirectory: "/user data/governor/jobs",
      log: vi.fn()
    });

    await expect(server.ensureRunning({
      baseUrl: "http://127.0.0.1:8787",
      enabled: true
    })).resolves.toBe("external");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("LocalGovernorServer disposal", () => {
  it("does not spawn after disposal while the initial probe and a queued restart are pending", async () => {
    let rejectProbe!: (error: Error) => void;
    vi.mocked(spawn).mockReturnValue(managedChild() as unknown as ReturnType<typeof spawn>);
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { rejectProbe = reject; }))
      .mockResolvedValue(healthyResponse()));
    const server = localServer();
    const options = { baseUrl: "http://127.0.0.1:8787", enabled: true };
    const pending = server.ensureRunning(options);
    const restarted = server.restart(options);
    server.dispose();
    rejectProbe(new TypeError("Connection refused"));

    await expect(pending).resolves.toBe("disabled");
    await expect(restarted).resolves.toBe("disabled");
    expect(spawn).not.toHaveBeenCalled();
    expect(server.ownsProcess).toBe(false);
  });

  it("does not report a disposed child as ready when a startup probe resolves", async () => {
    let finishProbe!: (response: Response) => void;
    let probing!: () => void;
    const probeStarted = new Promise<void>((resolve) => { probing = resolve; });
    const child = managedChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    vi.stubGlobal("fetch", vi.fn()
      .mockRejectedValueOnce(new TypeError("Connection refused"))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishProbe = resolve; probing(); })));
    const server = localServer();
    const pending = server.ensureRunning({ baseUrl: "http://127.0.0.1:8787", enabled: true });
    await probeStarted;
    server.dispose();
    finishProbe(healthyResponse());

    await expect(pending).resolves.toBe("disabled");
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(server.ownsProcess).toBe(false);
  });

  it.each(["target changed", "unresponsive child"])("does not respawn after disposal while stopping a %s", async (reason) => {
    const child = managedChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    vi.stubGlobal("fetch", vi.fn()
      .mockRejectedValueOnce(new TypeError("Connection refused"))
      .mockResolvedValueOnce(healthyResponse())
      .mockRejectedValue(new TypeError("Connection refused")));
    const server = localServer();
    await server.ensureRunning({ baseUrl: "http://127.0.0.1:8787", enabled: true });
    let stopping!: () => void;
    const stopStarted = new Promise<void>((resolve) => { stopping = resolve; });
    child.kill.mockImplementation(() => { stopping(); return true; });
    const pending = server.ensureRunning({
      baseUrl: reason === "target changed" ? "http://127.0.0.1:8788" : "http://127.0.0.1:8787",
      enabled: true
    });
    await stopStarted;
    server.dispose();
    child.signalCode = "SIGTERM";
    child.emit("exit", null, "SIGTERM");

    await expect(pending).resolves.toBe("disabled");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(server.ownsProcess).toBe(false);
  });

  it("ends a readiness retry delay quietly after disposal", async () => {
    vi.useFakeTimers();
    const child = managedChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Connection refused")));
    const server = localServer();
    const pending = server.ensureRunning({ baseUrl: "http://127.0.0.1:8787", enabled: true });
    const result = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    server.dispose();
    await vi.advanceTimersByTimeAsync(100);

    expect(await result).toEqual({ value: "disabled" });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(server.ownsProcess).toBe(false);
  });
});
