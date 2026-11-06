import { bindings, defineConfig, exports } from "cf/config";

import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig((ctx) => {
  const staging = ctx.mode === "staging";

  return {
    worker: {
      exports: {
        Auction: exports.durableObject({ storage: "sqlite" }),
        AuctionFanout: exports.durableObject({ storage: "sqlite" }),
      },
      name: staging ? "cloudflare-live-auction-staging" : "cloudflare-live-auction",
      compatibilityDate: "2026-08-22",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint,
      observability: {
        enabled: true,
        logs: {
          enabled: true,
          headSamplingRate: 1,
        },
        traces: {
          enabled: true,
          headSamplingRate: staging ? 1 : 0.1,
        },
      },
      env: {
        ENVIRONMENT: bindings.text(staging ? "staging" : "production"),
        DEMO_MODE: bindings.text(staging ? "enabled" : "disabled"),
        AUTH_ISSUER: bindings.text("https://cloudflare-live-auction.example"),
        AUTH_AUDIENCE: bindings.text("cloudflare-live-auction"),
        AUTH_JWKS_URL: bindings.text(""),
        WEB_ORIGINS: bindings.text(
          "https://live-auction.localhost,https://gavel-live-web.aranlucas.workers.dev",
        ),
        AUTH_JWKS_JSON: bindings.text(
          '{"keys":[{"kty":"EC","x":"YPrGDt7Vu1jwOGcQFdVDfbgQjiBe_Ds_8d_nKhVGeX8","y":"TpHR0QvFesA5VUnYeLLk2r_sPCJwMoVg3VPxR4I1gb4","crv":"P-256","alg":"ES256","use":"sig","kid":"6332bef5-8e80-4ef0-8022-8ed9ebd78377"}]}',
        ),
        READ_RATE_LIMITER: bindings.rateLimit({
          namespace: staging ? "1101" : "1201",
          simple: {
            limit: staging ? 600 : 240,
            period: 60,
          },
        }),
        COMMAND_RATE_LIMITER: bindings.rateLimit({
          namespace: staging ? "1102" : "1202",
          simple: {
            limit: staging ? 600 : 120,
            period: 60,
          },
        }),
      },
    },
  };
});
