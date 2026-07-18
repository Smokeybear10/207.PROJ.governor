import { createApp } from "./app.js";
import {
  parseStartupPort,
  validateStartupHost
} from "./startup.js";

const port = parseStartupPort(process.env.PORT);
const host = validateStartupHost(process.env.HOST);
const server = createApp().listen(port, host, () => {
  console.log(`Governor API listening on http://${host}:${port}`);
});

server.requestTimeout = 65_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
