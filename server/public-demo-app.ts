import { createApp } from "./app.js";

// Hosted routes are deterministic fixtures only. Live provider access remains
// an explicit local operation.
export const publicDemoApp = createApp({
  provider: null,
  exposeGovernedApi: false
});
