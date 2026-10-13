import type { OxfmtConfig } from "oxfmt";
import base from "@aranlucas/oxforge/format-config";

const config: OxfmtConfig = {
  ...base,
  ignorePatterns: [...(base.ignorePatterns ?? []), "apps/web/src/routeTree.gen.ts", "openapi.yaml"],
};

export default config;
