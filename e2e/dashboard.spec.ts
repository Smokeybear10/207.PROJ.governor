import { expect, test, type Page } from "@playwright/test";
import type { Controller } from "../src/api";

const dashboardUrl = process.env.TOKEN_GOVERNOR_BASE_URL ?? "/";
const fixtureApiOrigin =
  process.env.TOKEN_GOVERNOR_BASE_URL?.startsWith("http")
    ? new URL(process.env.TOKEN_GOVERNOR_BASE_URL).origin
    : "http://127.0.0.1:5173";

async function gotoDashboard(page: Page): Promise<void> {
  await page.goto(dashboardUrl);
}

type MockOptions = {
  runDelayMs?: number;
  runStatus?: number;
  mutateCatalog?: (value: Record<string, unknown>) => void;
  mutateRun?: (value: Record<string, unknown>) => void;
};

async function mockDemoApi(
  page: Page,
  options: MockOptions = {}
): Promise<{ requests: Array<{ scenarioId: string; controller: Controller }> }> {
  const requests: Array<{ scenarioId: string; controller: Controller }> = [];
  const catalogResponse = await fetch(
    `${fixtureApiOrigin}/api/demo/catalog`
  );
  if (!catalogResponse.ok) {
    throw new Error("Could not load the server-shaped E2E catalog fixture.");
  }
  const catalog = (await catalogResponse.json()) as Record<string, unknown>;

  await page.route("**/api/demo/catalog", async (route) => {
    const response = structuredClone(catalog);
    options.mutateCatalog?.(response);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response)
    });
  });

  await page.route("**/api/demo/runs", async (route) => {
    const body = route.request().postDataJSON() as {
      scenarioId?: string;
      controller?: Controller;
    };

    if (!body.scenarioId || !body.controller) {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            message:
              "Expected POST /api/demo/runs body { scenarioId, controller }."
          }
        })
      });
      return;
    }

    requests.push({
      scenarioId: body.scenarioId,
      controller: body.controller
    });

    if (options.runDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.runDelayMs));
    }

    if (options.runStatus && options.runStatus !== 200) {
      await route.fulfill({
        status: options.runStatus,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "Synthetic run fixture was intentionally rejected." }
        })
      });
      return;
    }

    const fixtureResponse = await fetch(
      `${fixtureApiOrigin}/api/demo/runs`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );
    if (!fixtureResponse.ok) {
      throw new Error("Could not load the server-shaped E2E run fixture.");
    }
    const response = (await fixtureResponse.json()) as Record<string, unknown>;
    if (Array.isArray(response.events)) {
      response.events = response.events.map((event, index) => ({
        ...(event as Record<string, unknown>),
        offsetMs: index * 100
      }));
    }
    options.mutateRun?.(response);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response)
    });
  });

  return { requests };
}

test("loads the default operation with explicit synthetic truth", async ({
  page
}) => {
  await mockDemoApi(page);
  await gotoDashboard(page);

  await expect(page.getByText("TokenGovernor", { exact: true })).toBeVisible();
  await expect(
    page.getByText("SCRIPTED FIXTURE / 0 EXTERNAL CALLS", { exact: true })
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Execution control" })).toBeVisible();
  await expect(page.getByLabel("Scenario")).toHaveValue(
    "large-failing-log"
  );
  await expect(page.getByLabel("Controller")).toHaveValue("static");
  await expect(
    page.getByRole("heading", { name: "Large failing test log" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Play scripted trace" })
  ).toBeEnabled();
  await expect(
    page.getByText("SYNTHETIC_DETERMINISTIC_FIXTURE", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("SIMULATED_LIST_PRICE_MICRO_USD", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText(/Pinned synthetic rate: openai\/gpt-5\.4-mini standard/)
  ).toContainText(
    "$0.750000 input, $0.075000 cached input, $4.500000 output per 1M tokens"
  );
  await expect(
    page.getByText("Pinned synthetic list-price calculations. Not billed.")
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/\bRUNNING\b/i);
  await expect(page.locator("body")).not.toContainText(/active predictor/i);
});

test("posts selected scenario and controller using the agreed contract", async ({
  page
}) => {
  const mock = await mockDemoApi(page);
  await gotoDashboard(page);

  await page.getByLabel("Scenario").selectOption("clean-small-diff");
  await page.getByLabel("Controller").selectOption("shadow");
  await expect(
    page.getByText(
      "A focused validation cleanup passes tests and should produce a finding-free review."
    )
  ).toBeVisible();

  await page.getByRole("button", { name: "Play scripted trace" }).click();

  await expect
    .poll(
      () => mock.requests,
      {
        message:
          "POST /api/demo/runs should receive the selected scenarioId and controller."
      }
    )
    .toEqual([
      { scenarioId: "clean-small-diff", controller: "shadow" }
    ]);
  await expect(
    page.getByRole("heading", { name: "Clean small diff" }).first()
  ).toBeVisible();
  await expect(
    page.getByText("NON-ACTING SHADOW", { exact: true }).first()
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/\bRUNNING\b/i);
  await expect(page.locator("body")).not.toContainText(/active predictor/i);
});

test("plays ordered events, completes, and replays without another POST", async ({
  page
}) => {
  const mock = await mockDemoApi(page, { runDelayMs: 120 });
  await gotoDashboard(page);

  await page.getByRole("button", { name: "Play scripted trace" }).click();
  await expect(page.getByRole("button", { name: "Loading fixture" })).toBeDisabled();
  await expect(page.getByText("Loading deterministic fixture")).toBeVisible();

  const timeline = page.getByRole("region", { name: "Execution timeline" });
  await expect(timeline.getByText("Synthetic review started")).toBeVisible();
  await expect(
    timeline.getByText("Large log reduced into an artifact")
  ).not.toBeVisible();
  await expect(
    timeline.getByText("Large log reduced into an artifact")
  ).toBeVisible();
  await expect(
    timeline.getByText("Review completed within policy")
  ).toBeVisible();

  await expect(
    page.getByRole("heading", {
      name: "Review completed after deterministic context controls."
    })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Quality-gated comparison" })
  ).toBeVisible();
  const comparison = page.getByLabel("Quality-gated comparison");
  await expect(page.getByText("NON-ACTING SHADOW").first()).toBeVisible();
  await expect(comparison.getByText("$0.018600", { exact: true })).toBeVisible();
  await expect(
    comparison.getByText("$0.044925", { exact: true }).first()
  ).toBeVisible();
  await expect(page.getByText("EXCLUDED", { exact: true })).toBeVisible();
  await expect(page.getByText("ELIGIBLE", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Fixture rubric score").first()).toBeVisible();
  await expect(page.getByText("WITHHELD", { exact: true })).toHaveCount(0);
  await expect(page.locator("body")).toContainText(
    "SIMULATED_LIST_PRICE_MICRO_USD"
  );
  await expect(page.locator("body")).toContainText("Not billed.");
  await expect(page.locator("body")).not.toContainText(/\bRUNNING\b/i);
  await expect(page.locator("body")).not.toContainText(/active predictor/i);

  await page.getByRole("button", { name: "Replay scripted trace" }).click();
  const truthStrip = page.getByLabel("Data provenance and run state");
  await expect(
    truthStrip.getByText("PLAYING TRACE", { exact: true })
  ).toBeVisible();
  await expect(timeline.getByText("Synthetic review started")).toBeVisible();
  await expect(
    truthStrip.getByText("TRACE COMPLETE", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("SCRIPTED REPLAY / 0 EXTERNAL CALLS", { exact: true })
  ).toBeVisible();
  expect(
    mock.requests,
    "Replay should use the immutable client trace and must not create another run."
  ).toHaveLength(1);
});

test("shows a useful backend error without losing run controls", async ({
  page
}) => {
  await mockDemoApi(page, { runStatus: 503 });
  await gotoDashboard(page);

  await page.getByRole("button", { name: "Play scripted trace" }).click();

  await expect(page.getByRole("alert")).toContainText("Demo run unavailable");
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic run fixture was intentionally rejected."
  );
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByLabel("Scenario")).toBeEnabled();
  await expect(page.getByLabel("Controller")).toBeEnabled();
});

test("fails closed when catalog provenance is missing", async ({ page }) => {
  await mockDemoApi(page, {
    mutateCatalog(value) {
      const benchmark = value.benchmark as Record<string, unknown>;
      delete benchmark.provenance;
    }
  });
  await gotoDashboard(page);

  await expect(page.getByRole("alert")).toContainText(
    "Demo catalog unavailable"
  );
  await expect(page.getByRole("alert")).toContainText(
    "Catalog benchmark is missing detailed demo provenance."
  );
  await expect(
    page.getByRole("button", { name: "Play scripted trace" })
  ).toBeDisabled();
});

test("fails closed when run provenance is missing", async ({ page }) => {
  await mockDemoApi(page, {
    mutateRun(value) {
      delete value.provenance;
    }
  });
  await gotoDashboard(page);

  await page.getByRole("button", { name: "Play scripted trace" }).click();
  await expect(page.getByRole("alert")).toContainText("Demo run unavailable");
  await expect(page.getByRole("alert")).toContainText(
    "Run response is missing detailed demo provenance."
  );
  await expect(page.getByText("PLAYING TRACE", { exact: true })).toHaveCount(0);
});

test("completed dashboard has no page-level mobile overflow", async ({
  page
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-390x844",
    "This assertion targets the agreed 390x844 mobile viewport."
  );

  await mockDemoApi(page);
  await gotoDashboard(page);
  await page.getByRole("button", { name: "Play scripted trace" }).click();
  await expect(
    page.getByRole("heading", { name: "Quality-gated comparison" })
  ).toBeVisible();

  const geometry = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const offenders = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .filter((element) => {
        const style = window.getComputedStyle(element);
        if (style.position === "fixed" || style.visibility === "hidden") {
          return false;
        }
        const bounds = element.getBoundingClientRect();
        return bounds.left < -1 || bounds.right > viewportWidth + 1;
      })
      .slice(0, 10)
      .map((element) => ({
        element: element.tagName.toLowerCase(),
        className: element.className,
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right)
      }));

    return {
      viewportWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      offenders
    };
  });

  expect(
    geometry.documentWidth,
    `Document width exceeded viewport: ${JSON.stringify(geometry)}`
  ).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(
    geometry.bodyWidth,
    `Body width exceeded viewport: ${JSON.stringify(geometry)}`
  ).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(
    geometry.offenders,
    `Elements escaped the mobile viewport: ${JSON.stringify(geometry.offenders)}`
  ).toEqual([]);
});
