# Development guide

Use Node.js 26 or later and the pnpm version declared in the root `package.json`. Install
dependencies from the repository root so the pnpm workspace links the shared API model into the
web app:

```sh
pnpm install
```

## Start the API and web app

Run the API in one terminal:

```sh
pnpm dev
```

The API is available at `https://api.live-auction.localhost`. In a second terminal, start the
browser client:

```sh
pnpm --filter gavel-live-web dev
```

The web app is available at `https://live-auction.localhost`. Both services use Portless; its first
run may ask to bind port 443 and trust a local certificate. The client defaults to the staging API.
Use **Room setup → Advanced setup** to enter a different API URL and auction credentials.

## Create local test credentials

The local API config uses the default issuer `https://cloudflare-live-auction.example` and audience
`cloudflare-live-auction`. To issue local tokens and create local demo sessions, generate a keypair
and configure Wrangler to verify the matching public key:

```sh
pnpm auth:keygen
```

The command writes `.auction-auth-private.jwk` and `.auction-auth-public.jwks.json` in the root and
prints a `wranglerValue` containing the public JWKS. Copy that public JWKS into the root `.dev.vars`
as `AUTH_JWKS_JSON`, and copy the private JWK from `.auction-auth-private.jwk` into the same file as
`DEMO_AUTH_PRIVATE_JWK`. `.dev.vars` and both key files are ignored by Git. Do not put the private
JWK in source control or share it.

Issue role-specific tokens with:

```sh
pnpm --silent auth:token -- --subject seller-1 --role seller
pnpm --silent auth:token -- --subject bidder-42 --role bidder
pnpm --silent auth:token -- --subject viewer-7 --role viewer
```

Tokens expire after 15 minutes by default. For another issuer, audience, or private JWK path, pass
`--issuer`, `--audience`, or `--private-jwk-path`; the API must be configured with the corresponding
issuer, audience, and public key.

## Checks and generated files

Useful root commands:

| Command                                    | Purpose                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `pnpm check`                               | Run type generation checks, typechecks, lint, format, OpenAPI checks, tests, builds, and deployment dry runs |
| `pnpm test`                                | Run the API and web-client Vitest suites                                                                     |
| `pnpm typecheck`                           | Typecheck API, tests, and scripts                                                                            |
| `pnpm lint`                                | Lint API, scripts, and web app                                                                               |
| `pnpm format`                              | Format supported project files                                                                               |
| `pnpm openapi`                             | Regenerate `openapi.yaml` from source schemas                                                                |
| `pnpm openapi:check`                       | Verify the checked-in OpenAPI file is current                                                                |
| `pnpm --filter gavel-live-web test:render` | Run the web app's rendered-page smoke test                                                                   |

When changing API schemas, update `src/model.ts`, regenerate `openapi.yaml` with `pnpm openapi`, and
check that the web app still consumes the shared model from `cloudflare-live-auction/model`.
TanStack file routes live in `apps/web/src/routes/`; the Vite dev/build flow generates
`apps/web/src/routeTree.gen.ts`.

API unit and Durable Object tests use the Cloudflare Vitest plugin and local Worker bindings. Web
tests use scripted HTTP and WebSocket transports. They do not require the deployed staging API.

`pnpm test:production -- <worker-url>` runs a separate integration script against a deployed API.
It creates auctions with unique IDs and performs real writes, so run it only against an environment
you administer. It requires a signing key that matches that API's configured public key. Set
`AUCTION_AUTH_PRIVATE_JWK`, `AUCTION_AUTH_ISSUER`, or `AUCTION_AUTH_AUDIENCE` to override the
defaults; `--no-report` disables its HTML report.

## Code map

- `src/index.ts` defines HTTP routes, JWT authentication, roles, CORS, request limits, and error
  responses.
- `src/auction.ts` implements the per-auction Durable Object and SQLite state machine.
- `src/fanout.ts` implements the sharded hibernating WebSocket delivery layer.
- `src/model.ts` contains shared schemas, event types, and response models.
- `apps/web/src/lib/auction-api.ts` contains REST helpers used by the web app.
- `apps/web/src/hooks/use-auction-room.ts` coordinates snapshot, history, and WebSocket updates.
