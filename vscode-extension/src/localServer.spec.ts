import { describe, expect, it } from "vitest";

import { managedServerTarget } from "./localServer";

describe("managedServerTarget", () => {
  it("accepts loopback HTTP endpoints", () => {
    expect(managedServerTarget("http://127.0.0.1:8787/")).toEqual({
      baseUrl: "http://127.0.0.1:8787",
      host: "127.0.0.1",
      port: 8787
    });
    expect(managedServerTarget("http://[::1]:9000")).toEqual({
      baseUrl: "http://[::1]:9000",
      host: "::1",
      port: 9000
    });
  });

  it.each([
    "https://127.0.0.1:8787",
    "http://192.0.2.10:8787",
    "http://localhost:8787/api"
  ])("does not manage custom endpoint %s", (value) => {
    expect(managedServerTarget(value)).toBeNull();
  });
});
