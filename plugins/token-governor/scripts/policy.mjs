import { createHash } from "node:crypto";

const MAX_WEIGHT = 1_000;

function positiveSafeInteger(value, label) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return number;
}

function positiveWeight(value, label) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > MAX_WEIGHT) {
    throw new Error(`${label} must be greater than 0 and at most ${MAX_WEIGHT}`);
  }
  return number;
}

export function defaultReminderThresholds(limitTokens) {
  const limit = positiveSafeInteger(limitTokens, "limitTokens");
  if (limit < 2) {
    throw new Error("limitTokens must be at least 2");
  }

  return [...new Set([
    Math.max(1, Math.floor(limit * 0.25)),
    Math.max(1, Math.floor(limit * 0.1))
  ])]
    .filter((threshold) => threshold < limit)
    .sort((left, right) => right - left);
}

export function normalizePolicy(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("policy must be an object");
  }

  const limitTokens = positiveSafeInteger(value.limitTokens, "limitTokens");
  if (limitTokens < 2) {
    throw new Error("limitTokens must be at least 2");
  }
  const inputWeight = positiveWeight(value.inputWeight, "inputWeight");
  const outputWeight = positiveWeight(value.outputWeight, "outputWeight");
  const rawReminders = value.reminders ?? defaultReminderThresholds(limitTokens);
  if (!Array.isArray(rawReminders) || rawReminders.length === 0) {
    throw new Error("reminders must contain at least one threshold");
  }

  const reminders = [...new Set(rawReminders.map((threshold) =>
    positiveSafeInteger(threshold, "reminder threshold")
  ))]
    .sort((left, right) => right - left);
  if (reminders.some((threshold) => threshold >= limitTokens)) {
    throw new Error("reminder thresholds must be below limitTokens");
  }

  return Object.freeze({
    limitTokens,
    inputWeight,
    outputWeight,
    reminders: Object.freeze(reminders)
  });
}

export function policyFingerprint(value) {
  const policy = normalizePolicy(value);
  return createHash("sha256")
    .update(JSON.stringify({
      limitTokens: policy.limitTokens,
      inputWeight: policy.inputWeight,
      outputWeight: policy.outputWeight,
      reminders: policy.reminders
    }), "utf8")
    .digest("hex");
}

export function policyEnvironment(value) {
  const policy = normalizePolicy(value);
  return Object.freeze({
    TOKEN_GOVERNOR_ACTIVE: "1",
    TOKEN_GOVERNOR_LIMIT_TOKENS: String(policy.limitTokens),
    TOKEN_GOVERNOR_INPUT_WEIGHT: String(policy.inputWeight),
    TOKEN_GOVERNOR_OUTPUT_WEIGHT: String(policy.outputWeight),
    TOKEN_GOVERNOR_REMINDERS: policy.reminders.join(","),
    TOKEN_GOVERNOR_POLICY_SHA256: policyFingerprint(policy)
  });
}

export function policyFromEnvironment(environment) {
  if (environment.TOKEN_GOVERNOR_ACTIVE !== "1") {
    throw new Error("governed launch marker is missing");
  }

  const reminders = String(environment.TOKEN_GOVERNOR_REMINDERS ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number);
  const policy = normalizePolicy({
    limitTokens: environment.TOKEN_GOVERNOR_LIMIT_TOKENS,
    inputWeight: environment.TOKEN_GOVERNOR_INPUT_WEIGHT,
    outputWeight: environment.TOKEN_GOVERNOR_OUTPUT_WEIGHT,
    reminders
  });
  if (policyFingerprint(policy) !== environment.TOKEN_GOVERNOR_POLICY_SHA256) {
    throw new Error("governed launch policy fingerprint does not match");
  }
  return policy;
}
