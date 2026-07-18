import { expect, test } from "@playwright/test";

test("runs the deterministic governed repair from the dedicated route", async ({
  page
}) => {
  await page.goto("/repair");

  await expect(page).toHaveTitle("Governor CI-Repair");
  await expect(page.getByRole("heading", { name: "CI-Repair" })).toBeVisible();
  await expect(page.getByLabel("Fixture")).toHaveValue("broken-sum");
  await expect(page.getByLabel("Execution mode")).toHaveValue("fake");

  await page.getByRole("button", { name: "Run governed repair" }).click();

  await expect(page.getByRole("status")).toContainText("Repaired");
  await expect(
    page.getByRole("heading", { name: "Verification gate" })
  ).toBeVisible();
  await expect(page.getByText("No policy violations recorded.")).toBeVisible();
  await expect(page.getByText("7 events", { exact: true })).toBeVisible();
  await expect(page.getByText(/resp_script_4/)).toBeVisible();
  await expect(page.getByText("4,524 micro-USD settled")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});

test("links the operations dashboard and CI-Repair views", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "CI-Repair" }).click();

  await expect(page).toHaveURL(/\/repair$/);
  await expect(page.getByRole("heading", { name: "CI-Repair" })).toBeVisible();

  await page.getByRole("link", { name: "Operations dashboard" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: "AI agents that finish under budget" })
  ).toBeVisible();
});
