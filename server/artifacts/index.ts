import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const strictUtf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true
});

export class ArtifactStoreError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ArtifactStoreError";
  }
}

export interface ArtifactReference {
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: "text/plain";
}

export interface ArtifactStore {
  putText(text: string): Promise<ArtifactReference>;
  readText(sha256: string): Promise<string>;
}

function assertMaxBytes(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new ArtifactStoreError("maxBytes must be a positive safe integer.");
  }
  return maxBytes;
}

function encodeWellFormedText(text: string): Buffer {
  if (typeof text !== "string" || LONE_SURROGATE_PATTERN.test(text)) {
    throw new ArtifactStoreError("Artifact text must be well-formed UTF-16.");
  }
  return Buffer.from(text, "utf8");
}

function assertValidHash(sha256: string): string {
  if (typeof sha256 !== "string" || !SHA256_HEX_PATTERN.test(sha256)) {
    throw new ArtifactStoreError("The requested artifact hash is invalid.");
  }
  return sha256;
}

function assertBoundedBytes(bytes: number, maxBytes: number): void {
  if (bytes > maxBytes) {
    throw new ArtifactStoreError(
      `Artifact of ${bytes} bytes exceeds the ${maxBytes}-byte storage limit.`
    );
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function referenceFor(sha256: string, bytes: number): ArtifactReference {
  return Object.freeze({ sha256, bytes, mediaType: "text/plain" as const });
}

function decodeStrictUtf8(bytes: Buffer, sha256: string): string {
  try {
    return strictUtf8Decoder.decode(bytes);
  } catch (error) {
    throw new ArtifactStoreError(
      `Stored artifact ${sha256} is not valid UTF-8.`,
      { cause: error }
    );
  }
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new ArtifactStoreError(
      "The artifact store could not be accessed.",
      { cause: error }
    );
  }
}

export class MemoryArtifactStore implements ArtifactStore {
  readonly #maxBytes: number;
  readonly #artifacts = new Map<string, string>();

  constructor(maxBytes: number = DEFAULT_MAX_ARTIFACT_BYTES) {
    this.#maxBytes = assertMaxBytes(maxBytes);
  }

  async putText(text: string): Promise<ArtifactReference> {
    const bytes = encodeWellFormedText(text);
    assertBoundedBytes(bytes.byteLength, this.#maxBytes);
    const sha256 = hashBytes(bytes);
    this.#artifacts.set(sha256, text);
    return referenceFor(sha256, bytes.byteLength);
  }

  async readText(sha256: string): Promise<string> {
    const hash = assertValidHash(sha256);
    const text = this.#artifacts.get(hash);
    if (text === undefined) {
      throw new ArtifactStoreError(`Artifact ${hash} was not found.`);
    }
    return text;
  }
}

export class FileArtifactStore implements ArtifactStore {
  readonly #root: string;
  readonly #maxBytes: number;

  constructor(root: string, maxBytes: number = DEFAULT_MAX_ARTIFACT_BYTES) {
    if (typeof root !== "string" || root.trim().length === 0) {
      throw new ArtifactStoreError("An artifact root is required.");
    }
    this.#root = root;
    this.#maxBytes = assertMaxBytes(maxBytes);
  }

  async putText(text: string): Promise<ArtifactReference> {
    const bytes = encodeWellFormedText(text);
    assertBoundedBytes(bytes.byteLength, this.#maxBytes);
    const sha256 = hashBytes(bytes);
    const path = this.#pathFor(sha256);

    const existing = await lstatOrNull(path);
    if (existing !== null) {
      await this.#readVerifiedBytes(path, existing, sha256);
      return referenceFor(sha256, bytes.byteLength);
    }

    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.tmp-${randomBytes(8).toString("hex")}`;
    try {
      await writeFile(temporaryPath, bytes, { mode: 0o600, flag: "wx" });
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw new ArtifactStoreError(
        `Artifact ${sha256} could not be stored.`,
        { cause: error }
      );
    }
    return referenceFor(sha256, bytes.byteLength);
  }

  async readText(sha256: string): Promise<string> {
    const hash = assertValidHash(sha256);
    const path = this.#pathFor(hash);
    const stats = await lstatOrNull(path);
    if (stats === null) {
      throw new ArtifactStoreError(`Artifact ${hash} was not found.`);
    }
    const bytes = await this.#readVerifiedBytes(path, stats, hash);
    return decodeStrictUtf8(bytes, hash);
  }

  #pathFor(sha256: string): string {
    return join(this.#root, `${sha256}.log`);
  }

  async #readVerifiedBytes(
    path: string,
    stats: Stats,
    sha256: string
  ): Promise<Buffer> {
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new ArtifactStoreError(
        `Artifact ${sha256} must be a regular file.`
      );
    }
    assertBoundedBytes(stats.size, this.#maxBytes);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      throw new ArtifactStoreError(
        `Artifact ${sha256} could not be read.`,
        { cause: error }
      );
    }
    if (hashBytes(bytes) !== sha256) {
      throw new ArtifactStoreError(
        `Stored artifact content does not match its SHA-256 hash.`
      );
    }
    return bytes;
  }
}
