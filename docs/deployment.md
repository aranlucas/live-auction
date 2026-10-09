# Deployment guide

The API and web client are separate Cloudflare Workers. Their Wrangler configuration files define
the Durable Object bindings, rate limiters, runtime settings, and deployment environments:

- API: [`wrangler.jsonc`](../wrangler.jsonc)
- Web client: [`apps/web/wrangler.jsonc`](../apps/web/wrangler.jsonc)

The API Worker is named `cloudflare-live-auction`; its staging environment is
`cloudflare-live-auction-staging`. The web Worker is named `gavel-live-web`. The public staging and
demo URLs are listed in the root [README](../README.md).

## Configure authentication and origins

The API reads these variables from its Wrangler environment:

| Variable         | Purpose                                                   |
| ---------------- | --------------------------------------------------------- |
| `AUTH_ISSUER`    | Required JWT issuer claim                                 |
| `AUTH_AUDIENCE`  | Required JWT audience claim                               |
| `AUTH_JWKS_URL`  | Optional remote JWKS URL; takes precedence when non-empty |
| `AUTH_JWKS_JSON` | Public JWKS JSON used when `AUTH_JWKS_URL` is empty       |
| `WEB_ORIGINS`    | Comma-separated origins allowed by API CORS               |
| `DEMO_MODE`      | Enables or disables public demo-session routes            |
| `ENVIRONMENT`    | Environment label returned by `/health`                   |

The API verifies ES256 and RS256 JWTs. The public JWKS belongs in `AUTH_JWKS_JSON` or at the
configured JWKS URL. Never store a private signing key in Wrangler `vars` or commit it to Git. Use
the trusted identity provider's issuer and audience in deployed environments.

The staging environment enables `DEMO_MODE`; production disables it. Staging demo routes sign
15-minute, auction-scoped tokens with the `DEMO_AUTH_PRIVATE_JWK` Worker secret. Set that secret
for staging with Wrangler:

```sh
pnpm exec wrangler secret put DEMO_AUTH_PRIVATE_JWK --env staging
```

Paste the private JWK JSON when Wrangler prompts. Its `kid` and key pair must match a public key in
the staging `AUTH_JWKS_JSON` JWKS. Generate a pair with `pnpm auth:keygen`; the command prints the
public `wranglerValue` and writes the private key to an ignored file. If rotating the demo key,
deploy the matching public JWKS and private secret together. Production does not need this secret
while demo mode stays disabled.

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

The scripts build with Wrangler/Cloudflare's Vite integration before deployment. The API Wrangler
configuration declares SQLite Durable Object migrations and rate-limit bindings for both
environments. Review those bindings and authentication values before deploying a configuration
change.

## CI and integration checks

GitHub Actions runs type generation checks, typechecks, lint and formatting checks, OpenAPI
freshness, unit/integration tests, web builds, and deployment dry runs on pull requests and pushes
to `main`. It can also be started manually. The workflow does not deploy Workers.

`pnpm test:production -- <worker-url>` runs an optional live integration flow that writes auction
data to the supplied Worker. Run it only against a deployment you administer and with a private key
that matches that Worker’s configured public key. See [Development](development.md) for options.
