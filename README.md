# Gavel Live

Gavel Live is a live-auction demo built with Cloudflare Workers, Durable Objects, Hono, and React. A Durable Object owns each auction’s bids and deadline; WebSockets broadcast saved results to connected clients.

[Live demo](https://gavel-live-web.aranlucas.workers.dev) · [System design](SYSTEM_DESIGN.md) · [OpenAPI](openapi.yaml)

## Run locally

Requires Node.js 22+ and pnpm.

```bash
pnpm install
pnpm dev
```

Run all local checks with:

```bash
pnpm check
```

See [`apps/web/README.md`](apps/web/README.md) for web-client details. Keep auction signing keys in Worker secrets, never in Git.
