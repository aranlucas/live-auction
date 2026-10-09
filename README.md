# Gavel Live

Gavel Live is a live-auction demo built with Cloudflare Workers, Durable Objects, Hono, and React. A Durable Object owns each auction’s bids and deadline; WebSockets broadcast saved results to connected clients.

[Live demo](https://gavel-live-web.aranlucas.workers.dev) · [System design](SYSTEM_DESIGN.md) · [OpenAPI](openapi.yaml)

## Run locally

Requires Node.js 24+ and pnpm for local development with Portless.

```bash
pnpm install
npm install -g portless@0.15.7
pnpm dev
```

Run all local checks with:

```bash
pnpm check
```

See [`apps/web/README.md`](apps/web/README.md) for web-client details. Keep auction signing keys in Worker secrets, never in Git.

## Local URLs with Portless

The API and web client use separate routes and separate allocated backend ports.

The standard development command uses [Portless](https://github.com/vercel-labs/portless).
Install its pinned CLI once with Node.js 24 or newer, then run this repository's command after the
normal dependency and environment setup:

```sh
npm install -g portless@0.15.7
pnpm dev
```

The main checkout uses `https://api.live-auction.localhost` with the default proxy settings.
Use the URL printed by Portless if you have changed its proxy port, TLS, or TLD.
Linked Git worktrees get a branch prefix, so each checkout has its own origin.
The first HTTPS run can request local administrator permission to bind port 443,
trust its development certificate, and synchronize local hostnames. Ctrl+C stops
the child server and removes its route.

Start the web client in a second terminal:

```sh
pnpm --filter gavel-live-web dev
```

Its default URL is `https://live-auction.localhost`. Before using that UI against
the local API, set `WEB_ORIGINS` in the root gitignored `.dev.vars` to the exact
web origin (a comma-separated list if several origins are needed). Use the URL
printed for your worktree rather than a wildcard. In **Room setup → Advanced
setup**, select the local API URL and use the existing local test-token workflow.
The default instant demo points at staging, whose existing allowlist does not
automatically accept a new local origin. No staging allowlist is changed here.

Signing keys, authentication checks, and deployed Worker settings stay with their
existing setup.
