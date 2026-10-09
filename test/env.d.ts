declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

declare namespace Cloudflare {
  interface Env {
    // Test-only binding from vitest.config.ts: listDurableObjectIds() requires a namespace bound in env.
    AUCTIONS: DurableObjectNamespace<import("../src/auction").Auction>;
  }
}
