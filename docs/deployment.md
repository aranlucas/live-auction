# Deployment guide

The API and web client are separate Cloudflare Workers. Their `cloudflare.config.ts` files define
the Durable Object bindings, rate limiters, runtime settings, and deployment environments:

- API: [`cloudflare.config.ts`](../cloudflare.config.ts)
- Web client: [`apps/web/cloudflare.config.ts`](../apps/web/cloudflare.config.ts)

## Configure authentication and origins

Set `AUTH_ISSUER` and `AUTH_AUDIENCE` to the trusted identity provider. The API verifies ES256 and
RS256 JWTs using `AUTH_JWKS_URL` when non-empty, otherwise `AUTH_JWKS_JSON`. Keep only public keys
in configuration; private signing keys belong in Worker secrets. See [Security](../SECURITY.md)
for issuer and credential requirements.

The staging environment enables `DEMO_MODE`; production disables it. Staging demo routes sign
15-minute, auction-scoped tokens with the `DEMO_AUTH_PRIVATE_JWK` Worker secret. Set that secret
for staging with the Cloudflare CLI:

```sh
pnpm exec cf workers secrets bulk --worker cloudflare-live-auction-staging \
  --file <(node -e 'process.stdout.write(JSON.stringify({ DEMO_AUTH_PRIVATE_JWK: { type: "secret_text", text: require("fs").readFileSync(".auction-auth-private.jwk", "utf8") } }))')
```

This reads the private JWK from `.auction-auth-private.jwk` without putting it in a command
argument. Its `kid` and key pair must match a public key in the staging `AUTH_JWKS_JSON` JWKS.
Generate a pair with `pnpm auth:keygen`; the command prints the public `publicJwksValue` and writes
the private key to an ignored file. If rotating the demo key, deploy the matching public JWKS and
private secret together. Production does not need this secret while demo mode stays disabled.

Add each deployed web-client origin to `WEB_ORIGINS`, including any custom domains. Origins must
match exactly, including scheme and port. The API only applies CORS to `/v1/*` routes.

## Deploy

Authenticate the Cloudflare CLI for the account that owns the configured Workers, then run the
appropriate commands from the repository root:

```sh
pnpm deploy:dry-run
pnpm deploy:staging
pnpm deploy
```

`pnpm deploy:dry-run` builds and dry-runs both API environments. `pnpm deploy:staging` deploys the
API staging environment, and `pnpm deploy` deploys the API production environment. Deploy the web
client separately:

```sh
pnpm --filter gavel-live-web deploy:dry-run
pnpm --filter gavel-live-web deploy
```

These scripts build with the Cloudflare Vite plugin before deployment. Review the Durable Object
and rate-limit bindings and authentication values in each mode before changing configuration.

The [CI workflow](../.github/workflows/ci.yml) runs checks and deployment dry runs, without deploying
Workers. For an optional integration flow that writes data to a deployed API, see
[Development](development.md#checks-and-generated-files).
