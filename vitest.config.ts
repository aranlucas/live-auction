import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "test",
          DEMO_MODE: "enabled",
          AUTH_ISSUER: "https://auction.test",
          AUTH_AUDIENCE: "live-auction-test",
          AUTH_JWKS_URL: "",
          AUTH_JWKS_JSON:
            '{"keys":[{"kty":"EC","x":"IYqpUjFfCd9FMDnpzRlIx0tTSRpbI7m7-q-hdmbpOc8","y":"uP6hmtNlUIjz8wCDxZe0-T4gDJn7Oh7cZa_kYgKMlYU","crv":"P-256","kid":"test-key","alg":"ES256"}]}',
          DEMO_AUTH_PRIVATE_JWK:
            '{"kty":"EC","x":"IYqpUjFfCd9FMDnpzRlIx0tTSRpbI7m7-q-hdmbpOc8","y":"uP6hmtNlUIjz8wCDxZe0-T4gDJn7Oh7cZa_kYgKMlYU","crv":"P-256","d":"n-2hnjyEEPICbvTma4YoJeSnht8wo5zdkXFtTIv8-nQ","kid":"test-key","alg":"ES256"}',
        },
      },
    }),
  ],
});
