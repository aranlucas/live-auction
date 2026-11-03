import { defineConfig } from "vitest/config";

// Filesystem artifacts and local signing commands run in Node, without Worker bindings.
export default defineConfig({
  test: { include: ["test/tooling/**/*.test.ts"], environment: "node" },
});
