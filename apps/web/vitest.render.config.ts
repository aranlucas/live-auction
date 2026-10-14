import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/render/render-smoke.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 15000,
  },
});
