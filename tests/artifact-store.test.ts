import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ArtifactStoreError,
  FileArtifactStore,
  MemoryArtifactStore
} from "../server/artifacts/index.js";

const execFileAsync = promisify(execFile);

describe("artifact stores", () => {
  it("stores raw text under a stable SHA-256 reference", async () => {
    const store = new MemoryArtifactStore();

    const first = await store.putText("complete failing test log\n");
    const second = await store.putText("complete failing test log\n");

    expect(first).toEqual(second);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(store.readText(first.sha256)).resolves.toBe(
      "complete failing test log\n"
    );
  });

  it("rejects oversized artifacts before storage", async () => {
    const store = new MemoryArtifactStore(4);

    await expect(store.putText("12345")).rejects.toThrow(
      "exceeds the 4-byte storage limit"
    );
  });

  it("validates maxBytes consistently for memory and file stores", () => {
    const invalidLimits = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1
    ];

    for (const maxBytes of invalidLimits) {
      expect(() => new MemoryArtifactStore(maxBytes)).toThrow(
        "maxBytes must be a positive safe integer"
      );
      expect(() => new FileArtifactStore(tmpdir(), maxBytes)).toThrow(
        "maxBytes must be a positive safe integer"
      );
    }
  });

  it("requires a non-empty string artifact root", () => {
    for (const root of ["", " ", "\t\n", null, 42]) {
      expect(
        () => new FileArtifactStore(root as unknown as string)
      ).toThrow("An artifact root is required");
    }
  });

  it("rejects invalid hashes instead of constructing arbitrary paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-governor-artifacts-"));
    const stores = [
      new MemoryArtifactStore(),
      new FileArtifactStore(root)
    ];

    for (const store of stores) {
      await expect(store.readText("../../.env")).rejects.toBeInstanceOf(
        ArtifactStoreError
      );
      await expect(
        store.readText(42 as unknown as string)
      ).rejects.toThrow("artifact hash is invalid");
    }
  });

  it("rejects ill-formed UTF-16 before assigning an identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-governor-artifacts-"));
    const stores = [
      new MemoryArtifactStore(),
      new FileArtifactStore(root)
    ];

    for (const store of stores) {
      await expect(store.putText("\ud800")).rejects.toThrow(
        "well-formed UTF-16"
      );
      await expect(store.putText("\udc00")).rejects.toThrow(
        "well-formed UTF-16"
      );
    }
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("writes private, content-addressed files idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-governor-artifacts-"));
    const store = new FileArtifactStore(root);

    const reference = await store.putText("raw output");
    await expect(store.putText("raw output")).resolves.toEqual(reference);

    const path = join(root, `${reference.sha256}.log`);
    await expect(readFile(path, "utf8")).resolves.toBe("raw output");
    const metadata = await stat(path);
    expect(metadata.mode & 0o777).toBe(0o600);
    const rootMetadata = await stat(root);
    expect(rootMetadata.mode & 0o777).toBe(0o700);
  });

  it("round-trips the canonical UTF-8 representation without stripping a BOM", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-governor-artifacts-"));
    const store = new FileArtifactStore(root);
    const content = "\uFEFFartifact \u{1F600}";

    const reference = await store.putText(content);

    await expect(store.readText(reference.sha256)).resolves.toBe(content);
  });

  it("publishes concurrent identical writes as one complete file", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-governor-artifacts-"));
    const store = new FileArtifactStore(root);
    const content = "concurrent artifact\n".repeat(1024);

    const references = await Promise.all(
      Array.from({ length: 24 }, () => store.putText(content))
    );

    expect(new Set(references.map(({ sha256 }) => sha256)).size).toBe(1);
    const [reference] = references;
    await expect(
      readFile(join(root, `${reference.sha256}.log`), "utf8")
    ).resolves.toBe(content);
    await expect(readdir(root)).resolves.toEqual([
      `${reference.sha256}.log`
    ]);
  });

  it("rejects symlinks even when their target has the expected content", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-governor-artifacts-"));
    const targetRoot = await mkdtemp(
      join(tmpdir(), "token-governor-artifact-target-")
    );
    const content = "external artifact";
    const reference = await new MemoryArtifactStore().putText(content);
    const target = join(targetRoot, "external.log");
    await writeFile(target, content);
    await symlink(target, join(root, `${reference.sha256}.log`));

    const store = new FileArtifactStore(root);
    await expect(store.readText(reference.sha256)).rejects.toBeInstanceOf(
      ArtifactStoreError
    );
    await expect(store.putText(content)).rejects.toBeInstanceOf(
      ArtifactStoreError
    );
  });

  it("rejects an existing file whose content does not match its name", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-governor-artifacts-"));
    const content = "expected artifact";
    const reference = await new MemoryArtifactStore().putText(content);
    const path = join(root, `${reference.sha256}.log`);
    await writeFile(path, "substituted artifact");

    const store = new FileArtifactStore(root);
    await expect(store.putText(content)).rejects.toThrow(
      "does not match its SHA-256 hash"
    );
    await expect(store.readText(reference.sha256)).rejects.toThrow(
      "does not match its SHA-256 hash"
    );
    await expect(readFile(path, "utf8")).resolves.toBe("substituted artifact");
  });

  it("rejects hash-matching bytes that are not valid UTF-8", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-governor-artifacts-"));
    const bytes = Buffer.from([0xc3, 0x28]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(root, `${sha256}.log`), bytes);

    const store = new FileArtifactStore(root);
    await expect(store.readText(sha256)).rejects.toThrow(
      "not valid UTF-8"
    );
  });

  it("bounds disk reads and requires regular files", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-governor-artifacts-"));
    const oversized = await new MemoryArtifactStore().putText("12345");
    await writeFile(join(root, `${oversized.sha256}.log`), "12345");
    const directory = await new MemoryArtifactStore().putText("directory");
    await mkdir(join(root, `${directory.sha256}.log`));

    const store = new FileArtifactStore(root, 4);
    await expect(store.readText(oversized.sha256)).rejects.toThrow(
      "exceeds the 4-byte storage limit"
    );
    await expect(store.readText(directory.sha256)).rejects.toBeInstanceOf(
      ArtifactStoreError
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO without waiting for a writer",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "token-governor-artifacts-"));
      const reference = await new MemoryArtifactStore().putText("fifo");
      const path = join(root, `${reference.sha256}.log`);
      await execFileAsync("mkfifo", [path]);
      const store = new FileArtifactStore(root);
      const readAttempt = store.readText(reference.sha256);
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const outcome = await Promise.race([
        readAttempt.then(
          () => "resolved",
          () => "rejected"
        ),
        new Promise<"timed-out">((resolveTimeout) => {
          timeout = setTimeout(() => resolveTimeout("timed-out"), 500);
        })
      ]);
      clearTimeout(timeout);

      if (outcome === "timed-out") {
        const rescueHandle = await open(
          path,
          constants.O_RDWR | constants.O_NONBLOCK
        );
        await rescueHandle.close();
        await readAttempt.catch(() => undefined);
      }
      expect(outcome).toBe("rejected");
    }
  );
});
