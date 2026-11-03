import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import { buildOpenApiDocument } from "../../src/openapi";

it("keeps the published OpenAPI YAML identical to the generated source schemas", async () => {
  const existing = await readFile(new URL("../../openapi.yaml", import.meta.url), "utf8");
  expect(existing, "openapi.yaml is stale; run pnpm openapi").toBe(
    stringify(buildOpenApiDocument(), { lineWidth: 100 }),
  );
});

it("rejects the obsolete checker flag without changing the published document", async () => {
  const path = new URL("../../openapi.yaml", import.meta.url);
  const before = await readFile(path, "utf8");

  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/openapi.ts", "--check"], {
    encoding: "utf8",
  });

  expect(result.status).not.toBe(0);
  expect(await readFile(path, "utf8")).toBe(before);
});
