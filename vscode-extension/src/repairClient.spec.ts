import { describe, it, expect, vi } from "vitest";
import {
  RepairClient,
  GovernorApiError,
  formatMicroUsd,
  type RepairRunResponse
} from "./repairClient";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

describe("formatMicroUsd", () => {
  it("formats micro-USD into a six-digit dollar string", () => {
    expect(formatMicroUsd(1234)).toBe("$0.001234");
    expect(formatMicroUsd(0)).toBe("$0.000000");
    expect(formatMicroUsd(1_000_000)).toBe("$1.000000");
  });

  it("returns n/a for undefined or invalid amounts", () => {
    expect(formatMicroUsd(undefined)).toBe("n/a");
    expect(formatMicroUsd(Number.NaN)).toBe("n/a");
  });
});

describe("RepairClient.runRepair", () => {
  it("posts JSON to /api/repair/runs and normalizes a repaired result", async () => {
    const serverBody = {
      fixtureId: "broken-sum",
      mode: "fake",
      model: "test-model",
      rateCardVersion: "2024-01",
      policy: { budget_micro_usd: 50000 },
      result: {
        status: "repaired",
        finalText: "def sum(a, b):\n    return a + b\n",
        evaluation: {
          passed: true,
          targetPassed: true,
          policyRespected: true,
          exitCode: 0,
          violations: []
        },
        toolCalls: 3,
        revision: "rev-1",
        settledMicroUsd: 1234,
        trace: [
          { kind: "phase", sequence: 0, phase: "plan", status: "ok" },
          { kind: "tool", sequence: 1, name: "run_tests", state: "done" }
        ]
      }
    };
    const fetchImpl = vi.fn(async () => jsonResponse(201, serverBody));

    const client = new RepairClient({
      baseUrl: "http://127.0.0.1:8787/",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const out: RepairRunResponse = await client.runRepair({
      fixtureId: "broken-sum",
      mode: "fake"
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    expect(url).toBe("http://127.0.0.1:8787/api/repair/runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      fixtureId: "broken-sum",
      mode: "fake"
    });
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/json");
    expect(headers["Content-Type"]).toBe("application/json");

    expect(out.result.status).toBe("repaired");
    expect(out.result.settledMicroUsd).toBe(1234);
    expect(out.result.trace).toHaveLength(2);
    expect(out.result.trace[1]).toMatchObject({
      kind: "tool",
      sequence: 1,
      name: "run_tests",
      state: "done"
    });
    expect(out.result.evaluation?.passed).toBe(true);
  });

  it("applies default fixtureId and mode when no input is given", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, {
        fixtureId: "broken-sum",
        mode: "fake",
        model: "test-model",
        rateCardVersion: "2024-01",
        policy: {},
        result: {
          status: "not_repaired",
          reason: "MAX_RESPONSES_REACHED",
          finalText: null,
          evaluation: null,
          toolCalls: 0,
          revision: "rev-0",
          settledMicroUsd: 0,
          trace: []
        }
      })
    );
    const client = new RepairClient({
      baseUrl: "http://localhost:8787",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const out = await client.runRepair();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    expect(JSON.parse(init.body as string)).toEqual({
      fixtureId: "broken-sum",
      mode: "fake"
    });
    expect(out.result.finalText).toBeNull();
    expect(out.result.evaluation).toBeNull();
    expect(out.result.settledMicroUsd).toBe(0);
    expect(out.result.trace).toEqual([]);
  });

  it("rejects a malformed successful response", async () => {
    const client = new RepairClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: vi.fn(async () =>
        jsonResponse(201, { result: { status: "repaired" } })
      ) as unknown as typeof fetch
    });

    await expect(client.runRepair()).rejects.toMatchObject({
      name: "GovernorApiError",
      status: 200,
      code: "INVALID_RESPONSE"
    });
  });

  it("throws a GovernorApiError carrying the server code on non-2xx", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(422, {
        error: { code: "FIXTURE_NOT_FOUND", message: "unknown fixture" }
      })
    );
    const client = new RepairClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(client.runRepair()).rejects.toMatchObject({
      name: "GovernorApiError",
      status: 422,
      code: "FIXTURE_NOT_FOUND",
      message: "unknown fixture"
    });
    await expect(client.runRepair()).rejects.toBeInstanceOf(GovernorApiError);
  });

  it("wraps a thrown fetch as code NETWORK_ERROR", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("connection refused");
    });
    const client = new RepairClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(client.runRepair()).rejects.toMatchObject({
      name: "GovernorApiError",
      status: 0,
      code: "NETWORK_ERROR"
    });
  });
});

describe("RepairClient.health", () => {
  it("GETs /api/health and normalizes the payload", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        service: "token-governor",
        status: "ready",
        mode: "fake",
        providerConfigured: false,
        governedApi: true
      })
    );
    const client = new RepairClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const health = await client.health();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    expect(url).toBe("http://127.0.0.1:8787/api/health");
    expect(init.method).toBe("GET");
    expect(health).toEqual({
      service: "token-governor",
      status: "ready",
      mode: "fake",
      providerConfigured: false,
      governedApi: true
    });
  });

  it.each([
    ["unrelated-server", "ready", "INVALID_SERVICE"],
    ["token-governor", "failed", "SERVICE_NOT_READY"]
  ])("rejects service %s with status %s", async (service, status, code) => {
    const client = new RepairClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: vi.fn(async () => jsonResponse(200, {
        service, status, mode: "live", providerConfigured: true
      })) as typeof fetch
    });

    await expect(client.health()).rejects.toMatchObject({ code, status: 0 });
  });

  it.each([null, [], "ready", {}])("rejects malformed identity evidence: %j", async (body) => {
    const client = new RepairClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: vi.fn(async () => jsonResponse(200, body)) as typeof fetch
    });

    await expect(client.health()).rejects.toMatchObject({ code: "INVALID_SERVICE", status: 0 });
  });
});
