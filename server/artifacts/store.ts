import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  unlink
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const TEMP_CREATE_ATTEMPTS = 5;
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true
});

type FileIdentity = {
  dev: number;
  ino: number;
};

export type ArtifactReference = {
  sha256: string;
  bytes: number;
  mediaType: "text/plain";
};

export interface ArtifactStore {
  putText(content: string): Promise<ArtifactReference>;
  readText(sha256: string): Promise<string>;
}

export class ArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

function encodeArtifact(content: string): {
  bytes: Buffer;
  reference: ArtifactReference;
} {
  if (typeof content !== "string") {
    throw new ArtifactStoreError("Artifact content must be a string.");
  }
  assertWellFormedUtf16(content);

  const bytes = Buffer.from(content, "utf8");
  return {
    bytes,
    reference: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      mediaType: "text/plain"
    }
  };
}

function assertWellFormedUtf16(content: string): void {
  for (let index = 0; index < content.length; index += 1) {
    const codeUnit = content.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = content.charCodeAt(index + 1);
      if (
        index + 1 >= content.length ||
        nextCodeUnit < 0xdc00 ||
        nextCodeUnit > 0xdfff
      ) {
        throw new ArtifactStoreError(
          "Artifact content must be well-formed UTF-16."
        );
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new ArtifactStoreError(
        "Artifact content must be well-formed UTF-16."
      );
    }
  }
}

function decodeArtifact(bytes: Buffer): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new ArtifactStoreError("The artifact is not valid UTF-8.");
  }
}

function assertHash(sha256: unknown): asserts sha256 is string {
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
    throw new ArtifactStoreError("The artifact hash is invalid.");
  }
}

function assertMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new ArtifactStoreError("maxBytes must be a positive safe integer.");
  }
}

function assertSize(reference: ArtifactReference, maxBytes: number): void {
  if (reference.bytes > maxBytes) {
    throw new ArtifactStoreError(
      `The artifact exceeds the ${maxBytes}-byte storage limit.`
    );
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function sameFile(first: FileIdentity, second: FileIdentity): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

export class MemoryArtifactStore implements ArtifactStore {
  readonly #artifacts = new Map<string, string>();
  readonly #maxBytes: number;

  constructor(maxBytes = DEFAULT_MAX_BYTES) {
    assertMaxBytes(maxBytes);
    this.#maxBytes = maxBytes;
  }

  async putText(content: string): Promise<ArtifactReference> {
    const { reference } = encodeArtifact(content);
    assertSize(reference, this.#maxBytes);
    this.#artifacts.set(reference.sha256, content);
    return reference;
  }

  async readText(sha256: string): Promise<string> {
    assertHash(sha256);
    const content = this.#artifacts.get(sha256);
    if (content === undefined) {
      throw new ArtifactStoreError("The artifact does not exist.");
    }
    return content;
  }
}

export class FileArtifactStore implements ArtifactStore {
  readonly #root: string;
  readonly #maxBytes: number;

  constructor(root: string, maxBytes = DEFAULT_MAX_BYTES) {
    if (typeof root !== "string" || root.trim().length === 0) {
      throw new ArtifactStoreError("An artifact root is required.");
    }
    assertMaxBytes(maxBytes);
    this.#root = resolve(root);
    this.#maxBytes = maxBytes;
  }

  async putText(content: string): Promise<ArtifactReference> {
    const artifact = encodeArtifact(content);
    assertSize(artifact.reference, this.#maxBytes);
    const rootIdentity = await this.#prepareRoot();
    const finalPath = this.#pathFor(artifact.reference.sha256);
    const temporary = await this.#createTemporary(rootIdentity);

    try {
      await this.#writeFully(temporary.handle, artifact.bytes);
      await temporary.handle.sync();
      await temporary.handle.chmod(0o600);
      await this.#verifyHandleContent(
        temporary.handle,
        artifact.reference.sha256
      );
      await temporary.handle.sync();
      await this.#assertRoot(rootIdentity);
      await this.#assertPathMatchesHandle(
        temporary.path,
        temporary.handle
      );

      try {
        await link(temporary.path, finalPath);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }
        await this.#readVerified(
          artifact.reference.sha256,
          rootIdentity,
          true
        );
        return artifact.reference;
      }

      await this.#assertRoot(rootIdentity);
      await this.#assertPathMatchesHandle(finalPath, temporary.handle);
      return artifact.reference;
    } finally {
      try {
        await temporary.handle.close();
      } finally {
        try {
          await unlink(temporary.path);
        } catch (error) {
          if (!hasCode(error, "ENOENT")) {
            throw error;
          }
        }
      }
    }
  }

  async readText(sha256: string): Promise<string> {
    assertHash(sha256);
    const rootIdentity = await this.#assertRoot();
    const content = await this.#readVerified(sha256, rootIdentity);
    return decodeArtifact(content);
  }

  async #prepareRoot(): Promise<FileIdentity> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const identity = await this.#assertRoot(undefined, true);
    return this.#assertRoot(identity);
  }

  async #assertRoot(
    expected?: FileIdentity,
    makePrivate = false
  ): Promise<FileIdentity> {
    let handle: FileHandle;
    try {
      handle = await open(
        this.#root,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_DIRECTORY |
          constants.O_NONBLOCK
      );
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        throw new ArtifactStoreError("The artifact does not exist.");
      }
      if (hasCode(error, "ELOOP") || hasCode(error, "ENOTDIR")) {
        throw new ArtifactStoreError(
          "The artifact root must be a regular directory."
        );
      }
      throw error;
    }

    try {
      const identity = await this.#assertOpenRoot(handle, expected);
      if (makePrivate) {
        await handle.chmod(0o700);
        await this.#assertOpenRoot(handle, identity);
      }
      return identity;
    } finally {
      await handle.close();
    }
  }

  async #assertOpenRoot(
    handle: FileHandle,
    expected?: FileIdentity
  ): Promise<FileIdentity> {
    let pathMetadata;
    try {
      pathMetadata = await lstat(this.#root);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        throw new ArtifactStoreError("The artifact root changed.");
      }
      throw error;
    }
    const openedMetadata = await handle.stat();
    const identity = {
      dev: openedMetadata.dev,
      ino: openedMetadata.ino
    };
    if (
      !openedMetadata.isDirectory() ||
      !pathMetadata.isDirectory() ||
      !sameFile(identity, pathMetadata)
    ) {
      throw new ArtifactStoreError(
        "The artifact root must be a regular directory."
      );
    }
    if (expected !== undefined && !sameFile(identity, expected)) {
      throw new ArtifactStoreError("The artifact root changed.");
    }
    return identity;
  }

  async #createTemporary(rootIdentity: FileIdentity): Promise<{
    handle: FileHandle;
    path: string;
  }> {
    for (let attempt = 0; attempt < TEMP_CREATE_ATTEMPTS; attempt += 1) {
      const path = join(
        this.#root,
        `.artifact-${process.pid}-${randomBytes(16).toString("hex")}.tmp`
      );
      let handle: FileHandle;
      try {
        handle = await open(
          path,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600
        );
      } catch (error) {
        if (hasCode(error, "EEXIST")) {
          continue;
        }
        throw error;
      }

      try {
        await this.#assertRoot(rootIdentity);
        await this.#assertPathMatchesHandle(path, handle);
        return { handle, path };
      } catch (error) {
        try {
          await handle.close();
        } finally {
          try {
            await unlink(path);
          } catch (unlinkError) {
            if (!hasCode(unlinkError, "ENOENT")) {
              throw unlinkError;
            }
          }
        }
        throw error;
      }
    }

    throw new ArtifactStoreError(
      "Could not create a unique artifact temporary file."
    );
  }

  async #writeFully(handle: FileHandle, content: Buffer): Promise<void> {
    let offset = 0;
    while (offset < content.length) {
      const result = await handle.write(
        content,
        offset,
        content.length - offset,
        offset
      );
      if (result.bytesWritten === 0) {
        throw new ArtifactStoreError("The artifact could not be fully written.");
      }
      offset += result.bytesWritten;
    }
  }

  async #readVerified(
    sha256: string,
    rootIdentity: FileIdentity,
    makePrivate = false
  ): Promise<Buffer> {
    const path = this.#pathFor(sha256);
    let handle: FileHandle;
    try {
      handle = await open(
        path,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK
      );
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        throw new ArtifactStoreError("The artifact does not exist.");
      }
      if (hasCode(error, "ELOOP")) {
        throw new ArtifactStoreError("The artifact must be a regular file.");
      }
      throw error;
    }

    try {
      await this.#assertRoot(rootIdentity);
      await this.#assertPathMatchesHandle(path, handle);
      const content = await this.#verifyHandleContent(handle, sha256);
      await this.#assertPathMatchesHandle(path, handle);
      await this.#assertRoot(rootIdentity);
      if (makePrivate) {
        await handle.chmod(0o600);
        await this.#assertPathMatchesHandle(path, handle);
        await this.#assertRoot(rootIdentity);
      }
      return content;
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        throw new ArtifactStoreError("The artifact does not exist.");
      }
      throw error;
    } finally {
      await handle.close();
    }
  }

  async #assertPathMatchesHandle(
    path: string,
    handle: FileHandle
  ): Promise<void> {
    const [openedMetadata, pathMetadata] = await Promise.all([
      handle.stat(),
      lstat(path)
    ]);
    if (
      !openedMetadata.isFile() ||
      !pathMetadata.isFile() ||
      !sameFile(openedMetadata, pathMetadata)
    ) {
      throw new ArtifactStoreError("The artifact must be a regular file.");
    }
  }

  async #verifyHandleContent(
    handle: FileHandle,
    sha256: string
  ): Promise<Buffer> {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new ArtifactStoreError("The artifact must be a regular file.");
    }
    if (metadata.size > this.#maxBytes) {
      throw new ArtifactStoreError(
        `The artifact exceeds the ${this.#maxBytes}-byte storage limit.`
      );
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes <= this.#maxBytes) {
      const chunk = Buffer.allocUnsafe(
        Math.min(READ_CHUNK_BYTES, this.#maxBytes - bytes + 1)
      );
      const result = await handle.read(chunk, 0, chunk.length, bytes);
      if (result.bytesRead === 0) {
        break;
      }
      bytes += result.bytesRead;
      if (bytes > this.#maxBytes) {
        throw new ArtifactStoreError(
          `The artifact exceeds the ${this.#maxBytes}-byte storage limit.`
        );
      }
      chunks.push(chunk.subarray(0, result.bytesRead));
    }

    const content = Buffer.concat(chunks, bytes);
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== sha256) {
      throw new ArtifactStoreError(
        "The artifact content does not match its SHA-256 hash."
      );
    }
    return content;
  }

  #pathFor(sha256: string): string {
    assertHash(sha256);
    return join(this.#root, `${sha256}.log`);
  }
}
