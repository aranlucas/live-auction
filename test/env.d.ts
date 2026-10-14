import type { Auction } from "@/auction";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

declare global {
  namespace Cloudflare {
    interface Env {
      // Test-only binding from vitest.config.ts used by listDurableObjectIds().
      AUCTIONS: DurableObjectNamespace<Auction>;
    }
  }
}
