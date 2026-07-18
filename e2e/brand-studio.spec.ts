import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/brand");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
});

test("shows ten filterable identity directions", async ({ page }) => {
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Choose Governor's visual direction."
    })
  ).toBeVisible();
  await expect(page.getByLabel("Brand directions").getByRole("article")).toHaveCount(
    10
  );
  await expect(page.getByRole("heading", { name: "Aperture G" })).toBeVisible();
  await expect(page.getByText("Recommended starting point")).toBeVisible();

  await page.getByRole("tab", { name: "Financial 3" }).click();
  await expect(page.getByLabel("Brand directions").getByRole("article")).toHaveCount(
    3
  );
  await expect(page.getByRole("heading", { name: "Reserve Ring" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Threshold" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Split Reserve" })
  ).toBeVisible();
});

test("saves a direction locally and downloads its decision", async ({ page }) => {
  await page.getByRole("button", { name: "Choose Guardrails" }).click();

  await expect(page.getByLabel("Saved brand direction")).toContainText(
    "Guardrails"
  );
  await expect(page.getByText("Saved in this browser")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Saved brand direction")).toContainText(
    "Guardrails"
  );

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download decision" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    "governor-guardrails-decision.json"
  );
});

test("compares a shortlist and chooses from the comparison", async ({ page }) => {
  const aperture = page
    .getByLabel("Brand directions")
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Aperture G" }) });
  const relay = page
    .getByLabel("Brand directions")
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Relay" }) });

  await aperture.locator("label.compare-check").click();
  await relay.locator("label.compare-check").click();
  await expect(aperture.getByLabel("Compare")).toBeChecked();
  await expect(relay.getByLabel("Compare")).toBeChecked();
  await page.getByRole("button", { name: "Compare 2" }).click();

  const dialog = page.getByRole("dialog", { name: "Compare in context" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Aperture G" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Relay" })).toBeVisible();

  await dialog.getByRole("button", { name: "Choose Relay" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel("Saved brand direction")).toContainText("Relay");
});

test("does not overflow the viewport", async ({ page }) => {
  await page.getByRole("button", { name: "Choose Aperture G" }).click();

  const geometry = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth
  }));

  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.viewportWidth);
});
