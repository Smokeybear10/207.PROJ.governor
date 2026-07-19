import { createApp } from "./app.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { FileJobStore } from "./jobs/store.js";
import {
  parseStartupPort,
  validateStartupHost
} from "./startup.js";

const port = parseStartupPort(process.env.PORT);
const host = validateStartupHost(process.env.HOST);
const stateDirectory = process.env.GOVERNOR_STATE_DIR || join(homedir(), ".governor", "jobs");
const store = await FileJobStore.open(stateDirectory);
let repairStore: FileJobStore;
let app: ReturnType<typeof createApp>;
try {
  repairStore = await FileJobStore.open(join(stateDirectory, "repairs"));
  try {
    app = createApp({ jobStore: store, repairStore });
  } catch (error) {
    await repairStore.close();
    throw error;
  }
} catch (error) {
  await store.close();
  throw error;
}
const server = app.listen(port, host, () => {
  console.log(`Governor API listening on http://${host}:${port}`);
});

server.once("close", () => { void Promise.all([store.close(), repairStore.close()]); });
server.once("error", async (error) => {
  await Promise.all([store.close(), repairStore.close()]);
  console.error(error.message);
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

server.requestTimeout = 65_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
