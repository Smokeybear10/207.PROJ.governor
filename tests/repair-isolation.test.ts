import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("repair isolation availability", () => {
  it("fails closed on unsupported platforms", async () => {
    vi.resetModules();
    Object.defineProperty(process, "platform", {...platform, value: "linux"});
    const { prepareIsolatedTests } = await import("../server/repair/isolation.js");
    await expect(prepareIsolatedTests("/", ["node", "--test"])).rejects.toMatchObject({
      code: "REPAIR_ISOLATION_UNAVAILABLE",
      message: expect.stringContaining("host execution is disabled")
    });
  });

  it("requires a standalone Node runtime rather than the editor's executable", async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), "governor-empty-runtime-"));
    vi.resetModules();
    vi.stubEnv("PATH", emptyPath);
    try {
      const { prepareIsolatedTests } = await import("../server/repair/isolation.js");
      await expect(prepareIsolatedTests(emptyPath, ["node", "--test"])).rejects.toMatchObject({
        code: "REPAIR_ISOLATION_UNAVAILABLE",
        message: expect.stringContaining("standalone Node.js 22.8")
      });
    } finally {
      await rm(emptyPath, { recursive: true, force: true });
    }
  });

  it("refuses arbitrary shell commands and Node startup hooks", async () => {
    const { prepareIsolatedTests } = await import("../server/repair/isolation.js");
    for (const command of [["sh", "-c", "true"], ["node", "--require", "outside.cjs", "--test"], ["node", "-e", "process.exit(0)"],
      ["node", "--test", "--import=outside.mjs"], ["node", "--test", "../outside.mjs"],
      ["node", "--test", "/outside.mjs"], ["node", "--test", "test/*.mjs"],
      ["node", "--test", "test\\outside.mjs"], ["node", "--test", "test.mjs", "test.mjs"]]) {
      await expect(prepareIsolatedTests("/", command)).rejects.toThrow("only the pinned node --test command");
    }
  });
});
