import { z } from "zod";
import { ApiError, errorMessage } from "../errors.js";
import type { GovernedJobService } from "../jobs/index.js";
import type { JobStore } from "../jobs/store.js";
import { parseRepositoryRequest, repositoryFingerprint, runRepositoryRepair, type RepositoryRepairResult } from "./repository.js";

const savedRunSchema = z.object({
  id: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["running", "completed", "failed"]),
  output: z.unknown().optional(),
  jobId: z.string().max(128).optional(),
  error: z.string().max(2_000).optional()
}).strict();
type SavedRun = z.infer<typeof savedRunSchema>;

export class RepositoryRepairRuns {
  readonly #runs = new Map<string, SavedRun>();
  readonly #service: GovernedJobService;
  readonly #store?: JobStore;
  #pending?: Promise<void>;
  #storageError = false;

  constructor(service: GovernedJobService, store?: JobStore) {
    this.#service = service;
    this.#store = store;
    for (const value of store?.load() ?? []) {
      const record = savedRunSchema.parse(value);
      if (this.#runs.has(record.id)) throw new Error("Duplicate saved repair run.");
      if (record.status === "running") {
        record.status = "failed";
        record.error = "The service stopped before this repair finished. Saved changes are unverified. No model requests were retried; check the linked job for held reservations.";
        store?.save(record.id, record);
      }
      this.#runs.set(record.id, record);
    }
  }

  start(value: unknown): Record<string, unknown> {
    this.#assertAvailable();
    const request = parseRepositoryRequest(value);
    const fingerprint = repositoryFingerprint(request);
    const existing = this.#runs.get(request.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ApiError("REPAIR_REQUEST_CONFLICT", "This request ID already belongs to a different repair snapshot or budget.", 409);
      return this.#view(existing);
    }
    if (this.#pending) throw new ApiError("REPAIR_BUSY", "Another repository repair is running. Reopen it or wait for it to finish.", 409);
    if (this.#runs.size >= 200) throw new ApiError("REPAIR_HISTORY_FULL", "The local repair history has reached its 200-run limit. Archive the repair history before starting another run.", 409);
    const record: SavedRun = { id: request.requestId, fingerprint, status: "running" };
    this.#persist(record);
    this.#pending = runRepositoryRepair(request, {
      service: this.#service,
      onCheckpoint: (result) => this.#checkpoint(record, result)
    }).then((result) => {
      this.#checkpoint(record, result, "completed");
    }).catch((error: unknown) => {
      record.status = "failed";
      record.error = errorMessage(error).slice(0, 2_000);
      try {
        this.#persist(record);
      } catch {
        this.#storageError = true;
        record.error = "Repair stopped because local storage failed. Any returned changes are unverified and may not survive a restart. Check the linked job before starting again.";
      }
      this.#runs.set(record.id, record);
    }).finally(() => { this.#pending = undefined; });
    return this.#view(record);
  }

  get(id: string): Record<string, unknown> {
    const record = this.#runs.get(id);
    if (!record) throw new ApiError("REPAIR_NOT_FOUND", "This repair run was not found on this service.", 404);
    return this.#view(record);
  }

  async waitForIdle(): Promise<void> {
    await this.#pending;
  }

  #checkpoint(record: SavedRun, result: RepositoryRepairResult, status: SavedRun["status"] = "running"): void {
    Object.assign(record, { status, output: result, jobId: result.jobId });
    this.#persist(record);
  }

  #persist(record: SavedRun): void {
    this.#assertAvailable();
    this.#store?.save(record.id, record);
    this.#runs.set(record.id, record);
  }

  #assertAvailable(): void {
    if (this.#storageError) throw new ApiError("REPAIR_STORAGE_UNAVAILABLE", "Repair storage is unavailable. Restart the service before starting another repair.", 503);
    this.#store?.assertAvailable();
  }

  #view(record: SavedRun): Record<string, unknown> {
    return {
      requestId: record.id,
      status: record.status,
      ...(record.output === undefined || record.status === "running" ? {} : { result: record.output }),
      ...(record.jobId === undefined ? {} : { jobId: record.jobId }),
      ...(record.error === undefined ? {} : { error: record.error })
    };
  }
}
