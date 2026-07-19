import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { FileJobStore } from "../server/jobs/store.js";

const directories: string[] = [];
const stores: FileJobStore[] = [];
const children: ChildProcess[] = [];
const storeUrl = new URL("../server/jobs/store.ts", import.meta.url).href;

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "governor-writer-lock-"));
  directories.push(path);
  return path;
}

async function openStore(path: string, retries = 0): Promise<FileJobStore> {
  const store = await FileJobStore.open(path, retries);
  stores.push(store);
  return store;
}

function writer(path: string, source: string) {
  const child = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval",
    `import { FileJobStore } from ${JSON.stringify(storeUrl)};
     const store = await FileJobStore.open(process.argv[1], 0);
     ${source}`,
    path
  ], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", () => {
      if (output.includes("ready\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`Writer exited before ready: ${output}`)));
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { child, ready, exited, output: () => output };
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe("Governor job store writer ownership", () => {
  it("releases a healthy owner for immediate reopening", async () => {
    const path = directory();
    const first = await openStore(path);
    first.save("job_check", { id: "job_check", writer: "first" });
    await expect(FileJobStore.open(path, 0)).rejects.toMatchObject({ code: "ELOCKED" });
    await first.close();
    expect(() => first.assertAvailable()).toThrow("unavailable");
    const second = await openStore(path);
    expect(second.load()).toEqual([{ id: "job_check", writer: "first" }]);
    second.save("job_check", { id: "job_check", writer: "second" });
  });

  it("permanently stops an expired writer before creating temporary data", async () => {
    const path = directory();
    const expired = await openStore(path);
    const lockPath = join(path, ".writer.lock");
    utimesSync(lockPath, new Date(0), new Date(0));
    expect(() => expired.save("job_check", { id: "job_check" })).toThrow("unavailable");
    expect(readdirSync(path)).toEqual([".writer.lock"]);
    utimesSync(lockPath, new Date(), new Date());
    expect(() => expired.assertAvailable()).toThrow("unavailable");
    expect(readdirSync(path)).toEqual([".writer.lock"]);
    utimesSync(lockPath, new Date(0), new Date(0));
    const recovered = await openStore(path);
    await expired.close();
    await expect(FileJobStore.open(path, 0)).rejects.toMatchObject({ code: "ELOCKED" });
    recovered.save("job_check", { id: "job_check", writer: "recovered" });
  });

  it.each(["close", "exit"] as const)(
    "fences a paused process before rename and preserves its successor lock on %s",
    async (shutdown) => {
      const path = directory();
      const paused = writer(path, `
        try {
          store.save("job_check", {
            toJSON() {
              console.log("ready");
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8500);
              return { id: "job_check", writer: "old" };
            }
          });
          console.log("write accepted");
        } catch {
          console.log("write rejected");
        }
        try {
          store.save("job_check", { id: "job_check", writer: "resumed" });
          console.log("resumed write accepted");
        } catch {
          console.log("resumed write rejected");
        }
        ${shutdown === "close" ? "await store.close();" : "process.exit(0);"}
      `);
      await paused.ready;
      await delay(6500);
      const successor = await openStore(path);
      successor.save("job_check", { id: "job_check", writer: "new" });
      expect(await paused.exited).toBe(0);
      expect(paused.output()).toContain("write rejected");
      expect(paused.output()).toContain("resumed write rejected");
      expect(paused.output()).not.toContain("write accepted");
      expect(successor.load()).toEqual([{ id: "job_check", writer: "new" }]);
      await expect(FileJobStore.open(path, 0)).rejects.toMatchObject({ code: "ELOCKED" });
      expect(readdirSync(path).sort()).toEqual([".writer.lock", "job_check.json"]);
    },
    15_000
  );

  it("recovers an abruptly terminated writer without losing saved data", async () => {
    const path = directory();
    const owner = writer(path, `
      store.save("job_check", { id: "job_check", writer: "terminated" });
      console.log("ready");
      setInterval(() => {}, 1000);
    `);
    await owner.ready;
    owner.child.kill("SIGKILL");
    await owner.exited;
    const recovered = await openStore(path, 6);
    expect(recovered.load()).toEqual([{ id: "job_check", writer: "terminated" }]);
    recovered.save("job_check", { id: "job_check", writer: "recovered" });
  }, 15_000);
});
