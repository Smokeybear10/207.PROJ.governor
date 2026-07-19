import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import { lock } from "proper-lockfile";

export type JobStore = {
  assertAvailable(): void;
  load(): unknown[];
  save(id: string, value: unknown): void;
};

const JOB_FILE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.json$/;
const MAX_JOB_FILE_BYTES = 64 * 1024 * 1024;
const LOCK_STALE_MS = 5_000;

type LockIdentity = {
  dev: number;
  ino: number;
  birthtimeMs: number;
};

export class FileJobStore implements JobStore {
  readonly #directory: string;
  readonly #lockPath: string;
  #lockIdentity?: LockIdentity;
  #release?: () => Promise<void>;
  #failed = false;
  #compromised = false;

  private constructor(directory: string) {
    this.#directory = resolve(directory);
    this.#lockPath = join(this.#directory, ".writer.lock");
  }

  static async open(directory: string, retries = 6): Promise<FileJobStore> {
    const store = new FileJobStore(directory);
    mkdirSync(store.#directory, { recursive: true, mode: 0o700 });
    chmodSync(store.#directory, 0o700);
    store.#release = await lock(store.#directory, {
      lockfilePath: store.#lockPath,
      stale: LOCK_STALE_MS,
      update: 1_000,
      fs: store.#lockFilesystem(),
      retries: { retries, factor: 1, minTimeout: 1_000, maxTimeout: 1_000 },
      onCompromised: () => {
        store.#failed = true;
        store.#compromised = true;
      }
    });
    try {
      const identity = lstatSync(store.#lockPath);
      store.#lockIdentity = {
        dev: identity.dev,
        ino: identity.ino,
        birthtimeMs: identity.birthtimeMs
      };
      store.assertAvailable();
    } catch (error) {
      store.#failed = true;
      store.#compromised = true;
      await store.close();
      throw error;
    }
    return store;
  }

  assertAvailable(): void {
    if (this.#failed || this.#release === undefined || !this.#ownsFreshLock()) {
      throw new Error("Governor job storage is unavailable; restart the service before spending.");
    }
  }

  load(): unknown[] {
    this.assertAvailable();
    return readdirSync(this.#directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        const file = join(this.#directory, name);
        const stat = lstatSync(file);
        if (!JOB_FILE.test(name) || !stat.isFile() || stat.size > MAX_JOB_FILE_BYTES) {
          throw new Error(`Invalid Governor job file: ${name}`);
        }
        const value: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (typeof value !== "object" || value === null || !("id" in value) || `${value.id}.json` !== name) {
          throw new Error(`Governor job ID does not match its file: ${name}`);
        }
        return value;
      });
  }

  save(id: string, value: unknown): void {
    this.assertAvailable();
    if (!JOB_FILE.test(`${id}.json`)) {
      throw new Error("Invalid Governor job storage ID.");
    }
    const temporary = join(this.#directory, `.${id}.${randomUUID()}.tmp`);
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        throw new Error("Governor job state must be JSON-serializable.");
      }
      if (Buffer.byteLength(serialized, "utf8") > MAX_JOB_FILE_BYTES) {
        throw new Error("Governor job state exceeds the 64 MiB storage limit.");
      }
      this.assertAvailable();
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, serialized);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      this.assertAvailable();
      renameSync(temporary, join(this.#directory, `${id}.json`));
      if (process.platform !== "win32") {
        const directory = openSync(this.#directory, "r");
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      }
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  async close(): Promise<void> {
    const release = this.#release;
    this.#release = undefined;
    if (release !== undefined && this.#ownsFreshLock()) await release();
  }

  #ownsFreshLock(): boolean {
    if (this.#compromised) return false;
    try {
      const identity = this.#lockIdentity;
      const current = lstatSync(this.#lockPath);
      if (identity !== undefined && current.isDirectory() &&
        current.dev === identity.dev && current.ino === identity.ino &&
        current.birthtimeMs === identity.birthtimeMs &&
        current.mtimeMs > Date.now() - LOCK_STALE_MS) return true;
    } catch {
      // Missing or unreadable ownership evidence cannot authorize a writer.
    }
    this.#failed = true;
    this.#compromised = true;
    return false;
  }

  #lockFilesystem() {
    const removeOwnedLock = (path: fs.PathLike): void => {
      if (!this.#compromised &&
        (this.#lockIdentity === undefined || this.#ownsFreshLock())) rmdirSync(path);
    };
    return {
      ...fs,
      // Fence the library's delayed heartbeat and its process-exit cleanup too.
      utimes: (path: fs.PathLike, atime: fs.TimeLike, mtime: fs.TimeLike, callback: fs.NoParamCallback): void => {
        if (this.#lockIdentity === undefined) {
          fs.utimes(path, atime, mtime, callback);
          return;
        }
        let error: NodeJS.ErrnoException | null = null;
        try {
          if (!this.#ownsFreshLock()) {
            throw Object.assign(new Error("Governor job storage lock expired or changed owner."), {
              code: "ECOMPROMISED"
            });
          }
          utimesSync(path, atime, mtime);
        } catch (cause) {
          error = cause as NodeJS.ErrnoException;
        }
        callback(error);
      },
      rmdir: (path: fs.PathLike, callback: fs.NoParamCallback): void => {
        let error: NodeJS.ErrnoException | null = null;
        try {
          removeOwnedLock(path);
        } catch (cause) {
          error = cause as NodeJS.ErrnoException;
        }
        callback(error);
      },
      rmdirSync: removeOwnedLock
    };
  }
}
