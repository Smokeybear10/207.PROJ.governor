export const MAX_KNOWN_JOBS = 20;
const USD_PATTERN = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/;

export function isValidBudgetUsd(value: string): boolean {
  const normalized = value.trim();
  return USD_PATTERN.test(normalized) && Number(normalized) >= 0.000001;
}

export function normalizeKnownJobs(
  value: unknown,
  limit = MAX_KNOWN_JOBS
): string[] {
  if (!Array.isArray(value) || limit <= 0) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const id = entry.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    normalized.push(id);
    seen.add(id);
    if (normalized.length === limit) {
      break;
    }
  }
  return normalized;
}

export function rememberKnownJob(
  known: unknown,
  jobId: string,
  limit = MAX_KNOWN_JOBS
): string[] {
  const id = jobId.trim();
  if (!id || limit <= 0) {
    return normalizeKnownJobs(known, limit);
  }
  return [id, ...normalizeKnownJobs(known, limit)].filter(
    (entry, index, all) =>
      entry !== id || index === all.indexOf(id)
  ).slice(0, limit);
}

export function forgetKnownJob(known: unknown, jobId: string): string[] {
  return normalizeKnownJobs(known).filter((id) => id !== jobId);
}

export function normalizeIntegerSetting(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const candidate =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(candidate)));
}
