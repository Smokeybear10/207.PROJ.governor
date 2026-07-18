import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";

const servers: Server[] = [];

async function startApp(
  options: Parameters<typeof createApp>[0] = {}
): Promise<string> {
  const server = createApp(options).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

describe("Governor API", () => {
  it("reports readiness without exposing provider credentials", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/api/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "token-governor",
      status: "ready",
      mode: "demo",
      providerConfigured: false,
      governedApi: true
    });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("can limit a deployment to deterministic demo routes", async () => {
    const baseUrl = await startApp({
      provider: null,
      exposeGovernedApi: false
    });
    const health = await fetch(`${baseUrl}/api/health`);
    const jobs = await fetch(`${baseUrl}/v1/jobs`, { method: "POST" });

    expect(await health.json()).toMatchObject({
      providerConfigured: false,
      governedApi: false
    });
    expect(jobs.status).toBe(404);
    expect(await jobs.json()).toMatchObject({
      error: { code: "NOT_FOUND" }
    });
  });

  it("returns the strictly labeled deterministic catalog", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/api/demo/catalog`);
    const body = (await response.json()) as {
      scenarios: unknown[];
      benchmark: {
        mode: string;
        provenance: { externalApiCalls: number };
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.scenarios).toHaveLength(3);
    expect(body.benchmark).toMatchObject({
      mode: "DEMO",
      provenance: { externalApiCalls: 0 }
    });
  });

  it("creates a validated run trace", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/api/demo/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenarioId: "large-failing-log",
        controller: "shadow"
      })
    });
    const body = (await response.json()) as {
      id: string;
      truthLabel: string;
      events: unknown[];
    };

    expect(response.status).toBe(201);
    expect(body.id).toBe("demo-run:large-failing-log:shadow:v1");
    expect(body.truthLabel).toContain("no external model");
    expect(body.events.length).toBeGreaterThan(3);
  });

  it("rejects unknown controllers through the domain validator", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/api/demo/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenarioId: "large-failing-log",
        controller: "active_predictor"
      })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "UNKNOWN_CONTROLLER",
        message: "Unknown demo controller: active_predictor"
      }
    });
  });

  it("returns stable client errors for malformed JSON and oversized bodies", async () => {
    const baseUrl = await startApp();
    const invalid = await fetch(`${baseUrl}/api/demo/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{"
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "INVALID_JSON" }
    });

    const oversized = await fetch(`${baseUrl}/api/demo/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(300_000) })
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" }
    });
  });

  it("repairs a broken fixture through the governed repair endpoint", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/api/repair/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixtureId: "broken-sum", mode: "fake" })
    });
    const body = (await response.json()) as {
      mode: string;
      result: { status: string; evaluation?: { passed: boolean } };
    };

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.mode).toBe("fake");
    expect(body.result.status).toBe("repaired");
    expect(body.result.evaluation?.passed).toBe(true);
  });

  it("rejects an unknown repair fixture with a stable error", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/api/repair/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixtureId: "does-not-exist", mode: "fake" })
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "REPAIR_RUN_FAILED" }
    });
  });

  it("keeps unknown API routes behind the JSON error envelope", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/api/not-real`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "The API route does not exist."
      }
    });
  });
});
