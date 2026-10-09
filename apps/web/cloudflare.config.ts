import { defineConfig } from "cf/config";

import * as entrypoint from "./src/server.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "gavel-live-web",
    compatibilityDate: "2026-08-22",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    observability: {
      enabled: true,
      logs: {
        enabled: true,
        headSamplingRate: 1,
      },
      traces: {
        enabled: true,
        headSamplingRate: 0.1,
      },
    },
  },
});
