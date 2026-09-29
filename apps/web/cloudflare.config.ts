import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "gavel-live-web",
    compatibilityDate: "2026-08-22",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "@tanstack/react-start/server-entry",
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
