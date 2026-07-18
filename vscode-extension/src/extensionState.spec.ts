import { describe, expect, it } from "vitest";

import {
  forgetKnownJob,
  isValidBudgetUsd,
  normalizeIntegerSetting,
  normalizeKnownJobs,
  rememberKnownJob
} from "./extensionState";

describe("isValidBudgetUsd", () => {
  it.each(["0.000001", "0.075", "1", "999999.999999"])(
    "accepts %s",
    (value) => {
      expect(isValidBudgetUsd(value)).toBe(true);
    }
  );

  it.each(["0", "0.000000", "0.0000001", "-1", "01.0", "1000000"])(
    "rejects %s",
    (value) => {
      expect(isValidBudgetUsd(value)).toBe(false);
    }
  );
});

describe("known job history", () => {
  it("trims, deduplicates, and caps persisted job ids", () => {
    expect(
      normalizeKnownJobs([" a ", "b", "a", "", 12, "c"], 2)
    ).toEqual(["a", "b"]);
  });

  it("moves the active job to the front without growing forever", () => {
    expect(rememberKnownJob(["b", "a", "c"], "a", 3)).toEqual([
      "a",
      "b",
      "c"
    ]);
    expect(rememberKnownJob(["a", "b", "c"], "d", 3)).toEqual([
      "d",
      "a",
      "b"
    ]);
  });

  it("forgets a missing or expired job", () => {
    expect(forgetKnownJob(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
});

describe("normalizeIntegerSetting", () => {
  it("rounds finite values and applies both bounds", () => {
    expect(normalizeIntegerSetting(1_500.6, 2_000, 500, 10_000)).toBe(1_501);
    expect(normalizeIntegerSetting(-5, 2_000, 500, 10_000)).toBe(500);
    expect(normalizeIntegerSetting(50_000, 2_000, 500, 10_000)).toBe(10_000);
  });

  it("uses the fallback for invalid values", () => {
    expect(normalizeIntegerSetting(Number.NaN, 2_000, 500, 10_000)).toBe(
      2_000
    );
    expect(normalizeIntegerSetting("fast", 2_000, 500, 10_000)).toBe(2_000);
  });
});
