import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileJobStore } from "../server/jobs/store.js";

const directories: string[] = [];
const stores: FileJobStore[] = [];
const FILE_LIMIT_BYTES = 64 * 1024 * 1024;

async function openStore(directory: string): Promise<FileJobStore> {
  const store = await FileJobStore.open(directory, 0);
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("Governor job storage size boundary", () => {
  it("loads an exact-limit UTF-8 snapshot and preserves it when a later save exceeds the limit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "governor-job-size-"));
    directories.push(directory);
    const store = await openStore(directory);
    const id = "job_boundary";
    const filename = join(directory, `${id}.json`);
    const overhead = Buffer.byteLength(JSON.stringify({ id, payload: "" }), "utf8");
    const payloadBytes = FILE_LIMIT_BYTES - overhead;
    const payload = "é".repeat(Math.floor(payloadBytes / 2)) + "x".repeat(payloadBytes % 2);
    let serializations = 0;
    store.save(id, {
      toJSON() {
        serializations += 1;
        return { id, payload };
      }
    });
    expect(serializations).toBe(1);
    expect(statSync(filename).size).toBe(FILE_LIMIT_BYTES);
    const [boundary] = store.load() as Array<{ id: string; payload: string }>;
    expect(boundary.id).toBe(id);
    expect(boundary.payload.length).toBe(payload.length);

    expect(() => store.save(id, { id, payload: `${payload}é` })).toThrow(
      "exceeds the 64 MiB storage limit"
    );
    expect(statSync(filename).size).toBe(FILE_LIMIT_BYTES);
    expect(readdirSync(directory).sort()).toEqual([".writer.lock", `${id}.json`]);
    expect(() => store.assertAvailable()).toThrow("unavailable");
    await store.close();

    const reopened = await openStore(directory);
    const [retained] = reopened.load() as Array<{ id: string; payload: string }>;
    expect(retained.id).toBe(id);
    expect(retained.payload.length).toBe(payload.length);
    expect(retained.payload.endsWith("éx")).toBe(payload.endsWith("éx"));
  }, 10_000);
});
