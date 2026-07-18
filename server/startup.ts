const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function validateStartupHost(value: string | undefined): string {
  const host = value ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      "HOST must be one of 127.0.0.1, localhost, or ::1 for this unauthenticated POC."
    );
  }
  return host;
}

export function parseStartupPort(value: string | undefined): number {
  const port = Number(value ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}
