import { describe, expect, it } from "vitest";
import {
  parseStartupPort,
  validateStartupHost
} from "../server/startup.js";

describe("server startup host validation", () => {
  it("accepts only the supported loopback hosts", () => {
    expect(validateStartupHost(undefined)).toBe("127.0.0.1");
    expect(validateStartupHost("127.0.0.1")).toBe("127.0.0.1");
    expect(validateStartupHost("localhost")).toBe("localhost");
    expect(validateStartupHost("::1")).toBe("::1");
  });

  it("rejects non-loopback hosts", () => {
    for (const value of ["0.0.0.0", "::", "example.com"]) {
      expect(() => validateStartupHost(value)).toThrow(
        "HOST must be one of 127.0.0.1, localhost, or ::1"
      );
    }
  });

  it("accepts the default and valid port boundaries", () => {
    expect(parseStartupPort(undefined)).toBe(8787);
    expect(parseStartupPort("1")).toBe(1);
    expect(parseStartupPort("65535")).toBe(65535);
  });

  it("rejects invalid ports", () => {
    for (const value of ["0", "65536", "1.5", "abc"]) {
      expect(() => parseStartupPort(value)).toThrow(
        "PORT must be an integer between 1 and 65535"
      );
    }
  });
});
