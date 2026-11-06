// Native Hono schema generation supplies this repo's document; this command serializes it as the checked-in YAML contract.
// Freshness is asserted by test/tooling/openapi.test.ts in the existing Vitest runner.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { buildOpenApiDocument } from "../src/openapi";

parseArgs({ options: {}, allowPositionals: false });

const outputPath = new URL("../openapi.yaml", import.meta.url);

const generated = stringify(buildOpenApiDocument(), { lineWidth: 100 });

await writeFile(outputPath, generated);
