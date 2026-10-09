# Gavel Live test room

An original, Whatnot-inspired live-commerce test client for the Cloudflare auction API. It is a
TanStack Start application deployed on Cloudflare Workers and talks directly to the staging API
over authenticated REST and hibernating WebSockets.

## Run it

From the repository root:

```bash
pnpm install
npm install -g portless@0.15.7 # requires Node.js 24+
pnpm --filter gavel-live-web dev
```

Open the printed URL, normally `https://live-auction.localhost`. Start the local API
with `pnpm dev` in another terminal and follow the [local setup](../../README.md#local-urls-with-portless)
for its exact CORS origin and local test identities. Select the local API in
**Room setup → Advanced setup**.

### Staging demo preview

The staging demo currently allows `http://localhost:3000`. Start Vite on that
origin when previewing staging:

```bash
pnpm --filter gavel-live-web exec vite dev --port 3000 --strictPort
```

Open `http://localhost:3000` and select **Launch instant demo**. The app creates a scoped,
15-minute staging room, creates the camera lot, starts it, and connects the event stream. You can
bid immediately. The browser moves to the room's canonical `/auctions/{auctionId}` URL.

Select **Open another bidder** to open that auction in a new tab. A staging-only join endpoint
creates a different 15-minute bidder identity scoped to the live demo, and the new tab returns to
the same canonical auction URL. Repeat this for as many independent bidder tabs as you need; each
tab keeps its own credentials in `sessionStorage`, while WebSockets keep every tab synchronized.

For a custom API or identity provider, open **Room setup → Advanced setup**. Generate short-lived
test identities in another terminal:

```bash
pnpm --silent auth:token -- --subject seller-1 --role seller
pnpm --silent auth:token -- --subject bidder-42 --role bidder
pnpm --silent auth:token -- --subject viewer-7 --role viewer
```

Paste the tokens into advanced setup, choose a unique auction ID, then exercise the full flow:

1. Create the demo lot as seller.
2. Start it from Seller controls.
3. Bid using the yellow quick-bid control or the validated custom amount.
4. Watch REST results, the realtime connection, activity, and ordered event ledger update together.

Tokens are kept in `sessionStorage`, never persisted on the server, and are sent only to the API
URL shown in Setup. The included development signing key is for this system-design model only.

## Local URLs with Portless

From the repository root, use `pnpm --filter gavel-live-web dev`.
See the [root setup](../../README.md#local-urls-with-portless) for the pinned CLI,
the separate local API command, exact CORS origin, and local test identities.
The default browser URL is `https://live-auction.localhost`.

## Architecture

- TanStack Start, Router, Query, and Form for the application shell, URL state, server cache, and
  forms.
- Radix UI primitives for the accessible setup dialog.
- Zod 4 at URL, form, REST, and realtime boundaries; the client imports the authoritative auction
  schemas from the workspace API package.
- `react-use-websocket` for reconnect, heartbeat, and token-bearing WebSocket subprotocols.
- Lucide for icons, Sonner for command feedback, and date-fns for the live deadline.
- Cloudflare's Vite plugin and `@tanstack/react-start/server-entry` for a Workers-native build.

## Verify and deploy

```bash
pnpm --filter gavel-live-web test
pnpm --filter gavel-live-web typecheck
pnpm --filter gavel-live-web lint
pnpm --filter gavel-live-web build
pnpm --filter gavel-live-web deploy:dry-run
pnpm --filter gavel-live-web deploy
```

The web tests exercise the real room hook with scripted local HTTP and WebSocket transports.
They cover reordered snapshots, room and credential changes, and cancelled reads without
contacting the staging API. The root `pnpm test` runs both backend and web suites.

The accepted visual concept is [`design/gavel-live-concept.png`](./design/gavel-live-concept.png).
The production Worker name is configured as `gavel-live-web` in `cloudflare.config.ts`.
