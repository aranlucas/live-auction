import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";

export default {
  tests: "e2e/**/*.e2e.ts",
  targets: [
    {
      engine: web(),
      app: {
        url: "http://127.0.0.1:3000",
        command: {
          executable: "pnpm",
          args: [
            "--filter",
            "gavel-live-web",
            "exec",
            "vite",
            "--host",
            "127.0.0.1",
            "--port",
            "3000",
            "--strictPort",
          ],
          log: ".e2e/logs/web.log",
        },
      },
    },
  ],
  workers: 1,
  retries: 0,
  timeout: 90_000,
  assertionTimeout: 15_000,
  trace: "retain-on-failure",
  video: "retain-on-failure",
  reporters: ["list", "junit"],
} satisfies E2EConfig;
