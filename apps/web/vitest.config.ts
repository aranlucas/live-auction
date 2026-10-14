import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
    exclude: ["test/render/**"],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
