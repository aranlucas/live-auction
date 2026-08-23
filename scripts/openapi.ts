import { readFile, writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import { buildOpenApiDocument } from "../src/openapi";

const outputPath = new URL("../openapi.yaml", import.meta.url);
const generated = stringify(buildOpenApiDocument(), { lineWidth: 100 });

if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8");
  if (existing !== generated) {
    throw new Error("openapi.yaml is stale; run pnpm openapi");
  }
} else {
  await writeFile(outputPath, generated);
}
