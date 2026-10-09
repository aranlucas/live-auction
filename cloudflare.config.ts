import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig((ctx) => {
  switch (ctx.mode) {
    case "staging": {
      return {
        worker: {
          exports: {
            Auction: exports.durableObject({ storage: "sqlite" }),
            AuctionFanout: exports.durableObject({ storage: "sqlite" }),
          },
          name: "cloudflare-live-auction-staging",
          compatibilityDate: "2026-08-22",
          compatibilityFlags: ["nodejs_compat"],
          entrypoint: "src/index.ts",
          observability: {
            enabled: true,
            logs: {
              enabled: true,
              headSamplingRate: 1,
            },
            traces: {
              enabled: true,
              headSamplingRate: 1,
            },
          },
          env: {
            ENVIRONMENT: bindings.text("staging"),
            DEMO_MODE: bindings.text("enabled"),
            AUTH_ISSUER: bindings.text("https://cloudflare-live-auction.example"),
            AUTH_AUDIENCE: bindings.text("cloudflare-live-auction"),
            AUTH_JWKS_URL: bindings.text(""),
            WEB_ORIGINS: bindings.text(
              "https://live-auction.localhost,https://gavel-live-web.aranlucas.workers.dev",
            ),
            AUTH_JWKS_JSON: bindings.text(
              '{"keys":[{"kty":"EC","x":"YPrGDt7Vu1jwOGcQFdVDfbgQjiBe_Ds_8d_nKhVGeX8","y":"TpHR0QvFesA5VUnYeLLk2r_sPCJwMoVg3VPxR4I1gb4","crv":"P-256","alg":"ES256","use":"sig","kid":"6332bef5-8e80-4ef0-8022-8ed9ebd78377"}]}',
            ),
            AUCTIONS: bindings.durableObject({
              worker: "cloudflare-live-auction-staging",
              exportName: "Auction",
            }),
            AUCTION_FANOUT: bindings.durableObject({
              worker: "cloudflare-live-auction-staging",
              exportName: "AuctionFanout",
            }),
            READ_RATE_LIMITER: bindings.rateLimit({
              namespace: "1101",
              simple: {
                limit: 600,
                period: 60,
              },
            }),
            COMMAND_RATE_LIMITER: bindings.rateLimit({
              namespace: "1102",
              simple: {
                limit: 600,
                period: 60,
              },
            }),
          },
        },
      };
    }

    default: {
      return {
        worker: {
          exports: {
            Auction: exports.durableObject({ storage: "sqlite" }),
            AuctionFanout: exports.durableObject({ storage: "sqlite" }),
          },
          name: "cloudflare-live-auction",
          compatibilityDate: "2026-08-22",
          compatibilityFlags: ["nodejs_compat"],
          entrypoint: "src/index.ts",
          observability: {
            enabled: true,
            logs: {
              enabled: true,
              headSamplingRate: 1,
            },
            traces: {
              enabled: true,
              headSamplingRate: 0.1,
            },
          },
          env: {
            ENVIRONMENT: bindings.text("production"),
            DEMO_MODE: bindings.text("disabled"),
            AUTH_ISSUER: bindings.text("https://cloudflare-live-auction.example"),
            AUTH_AUDIENCE: bindings.text("cloudflare-live-auction"),
            AUTH_JWKS_URL: bindings.text(""),
            WEB_ORIGINS: bindings.text(
              "https://live-auction.localhost,https://gavel-live-web.aranlucas.workers.dev",
            ),
            AUTH_JWKS_JSON: bindings.text(
              '{"keys":[{"kty":"EC","x":"YPrGDt7Vu1jwOGcQFdVDfbgQjiBe_Ds_8d_nKhVGeX8","y":"TpHR0QvFesA5VUnYeLLk2r_sPCJwMoVg3VPxR4I1gb4","crv":"P-256","alg":"ES256","use":"sig","kid":"6332bef5-8e80-4ef0-8022-8ed9ebd78377"}]}',
            ),
            AUCTIONS: bindings.durableObject({
              worker: "cloudflare-live-auction",
              exportName: "Auction",
            }),
            AUCTION_FANOUT: bindings.durableObject({
              worker: "cloudflare-live-auction",
              exportName: "AuctionFanout",
            }),
            READ_RATE_LIMITER: bindings.rateLimit({
              namespace: "1201",
              simple: {
                limit: 240,
                period: 60,
              },
            }),
            COMMAND_RATE_LIMITER: bindings.rateLimit({
              namespace: "1202",
              simple: {
                limit: 120,
                period: 60,
              },
            }),
          },
        },
      };
    }
  }
});
