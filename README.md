# Cloudflare live auction

A working English-auction API on Cloudflare Workers. Each auction has one authoritative Durable Object that serializes bids, persists state in SQLite, and owns its deadline alarm. Realtime delivery is separated into four hibernating WebSocket fanout objects per auction.

```text
seller / bidder / viewer
          │ JWT + REST / WebSocket
          ▼
Cloudflare Worker (Hono + Zod)
  authentication · validation · rate limits · request IDs
          │ typed RPC by auction ID
          ▼
Auction Durable Object ───── ordered events ─────┐
  SQLite transaction + alarm                     │
  exact idempotency responses                    ▼
                                      4 AuctionFanout shards
                                      snapshots · cursor repair
                                      hibernating WebSockets
```

The invariant is: every bid, seller command, deadline extension, and close for one auction is processed by one logical owner in one total order. Fanout may scale independently, but it cannot decide auction state.

## Run locally

Requirements: Node.js 22 or newer and pnpm 11.

```bash
pnpm install
pnpm dev
```

Wrangler serves the API at `http://localhost:8787`. The repository already contains a local demo public key in `wrangler.jsonc`; its ignored private key, `.auction-auth-private.jwk`, signs 15-minute development tokens.

Mint identities in separate terminals:

```bash
SELLER_TOKEN=$(pnpm --silent auth:token -- --subject seller-1 --role seller)
BIDDER_TOKEN=$(pnpm --silent auth:token -- --subject bidder-42 --role bidder)
VIEWER_TOKEN=$(pnpm --silent auth:token -- --subject viewer-7 --role viewer)
```

Create a draft. Creation uses a client-chosen ID, so retrying the same `PUT` is naturally idempotent.

```bash
curl -i -X PUT http://localhost:8787/v1/auctions/camera-001 \
  -H "Authorization: Bearer $SELLER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "title": "Vintage camera",
    "currency": "USD",
    "startPriceCents": 1000,
    "minIncrementCents": 100,
    "durationSeconds": 60,
    "antiSnipeWindowSeconds": 10,
    "extensionSeconds": 10
  }'
```

Start it and bid. Money is always integer minor units: `1000` means USD 10.00.

```bash
curl -i -X POST http://localhost:8787/v1/auctions/camera-001/start \
  -H "Authorization: Bearer $SELLER_TOKEN" \
  -H 'Idempotency-Key: start-camera-001'

curl -i -X POST http://localhost:8787/v1/auctions/camera-001/bids \
  -H "Authorization: Bearer $BIDDER_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: bidder-42-attempt-1' \
  --data '{"amountCents":1000}'
```

Read the state and ordered event log:

```bash
curl -H "Authorization: Bearer $VIEWER_TOKEN" \
  http://localhost:8787/v1/auctions/camera-001

curl -H "Authorization: Bearer $VIEWER_TOKEN" \
  'http://localhost:8787/v1/auctions/camera-001/history?afterSequence=0&limit=50'
```

Browser WebSockets cannot set an `Authorization` header, so the realtime handshake carries a short-lived token as a subprotocol. The server selects only `auction.v1`, never echoes the credential protocol:

```js
const socket = new WebSocket("ws://localhost:8787/v1/auctions/camera-001/events?afterSequence=0", [
  "auction.v1",
  `auth.${viewerToken}`,
]);

socket.onmessage = ({ data }) => console.log(JSON.parse(data));
```

The first message is `auction.snapshot`. It contains the authoritative state, a cursor, bounded missed events after `afterSequence`, and `resyncRequired`. Subsequent messages are `auction.event`. Persist the cursor; if `resyncRequired` is true, fetch `/history` before continuing.

## API and validation

| Method | Path                                  | Purpose                                      |
| ------ | ------------------------------------- | -------------------------------------------- |
| `POST` | `/v1/demo-session`                    | Create a scoped 15-minute staging demo       |
| `POST` | `/v1/demo-session/{auctionId}/bidder` | Join a live demo as a distinct scoped bidder |
| `PUT`  | `/v1/auctions/{auctionId}`            | Create or replay an identical draft          |
| `GET`  | `/v1/auctions/{auctionId}`            | Read authoritative state                     |
| `POST` | `/v1/auctions/{auctionId}/start`      | Start the seller's draft                     |
| `POST` | `/v1/auctions/{auctionId}/bids`       | Submit an idempotent bid                     |
| `POST` | `/v1/auctions/{auctionId}/close`      | Finalize a live auction after its deadline   |
| `POST` | `/v1/auctions/{auctionId}/cancel`     | Cancel a draft or live auction               |
| `GET`  | `/v1/auctions/{auctionId}/history`    | Read ordered events after a sequence         |
| `GET`  | `/v1/auctions/{auctionId}/events`     | Upgrade to a cursor-aware WebSocket          |
| `GET`  | `/openapi.json`                       | Serve the generated OpenAPI 3.1 contract     |
| `GET`  | `/health`                             | Read service and environment health          |

Hono handles routing and middleware. Zod validates path, query, headers, bodies, JWT claims, SQL rows, stored JSON, RPC boundaries, and the discriminated event-payload union. There is no manual `action === "get"` dispatcher, `auctionStub` wrapper, unsafe cast-based row parser, or generic primitive-only event guard.

The checked-in [`openapi.yaml`](./openapi.yaml) is generated from the same schemas that validate requests and responses. `pnpm openapi:check` fails if it drifts.

## Correctness model

- A named `Auction` binding replaces the former stub wrapper: `env.AUCTIONS.getByName(auctionId).method(...)` is Cloudflare's typed RPC import for the remote object, not a local class import.
- SQLite schema migrations are numbered and validated. Database triggers enforce state, price, bid, event-sequence, and idempotency constraints underneath TypeScript.
- Each mutation and its event are committed in one synchronous SQLite transaction. Deadline changes and `setAlarm`/`deleteAlarm` are in the same Durable Object storage transaction.
- Idempotency is scoped by `(actor ID, idempotency key)` and stores the complete original success response. A replay after later bids or after the deadline returns that original snapshot and event with `replayed: true`.
- An alarm closes a live auction once. Reads and bids also finalize overdue state as a recovery path.
- Accepted events publish asynchronously to four delivery shards. Each shard retains 500 messages, caps itself at 2,000 sockets, and uses the Hibernation API.
- JWT `sub` is the actor ID; a signed `role` claim authorizes seller, bidder, or viewer actions. Caller-controlled `X-User-Id` and `X-User-Role` headers have no authority.
- Demo JWTs also carry an `auctionId` scope. The Worker rejects cross-room use before Durable Object lookup; ordinary provider-issued JWTs remain unscoped unless they include that claim.
- Read and command rate-limit bindings run before Durable Object lookup. Every response includes a validated or generated `X-Request-Id`; logs include that ID and `CF-Ray` when available.

## Verify and visualize

The repository also includes **Gavel Live**, an original Whatnot-inspired TanStack Start test room.
It provides seller controls, one-tap and custom bids, a live deadline, WebSocket connection state,
activity, and the durable ordered event ledger against the same API schemas.

```bash
pnpm --filter gavel-live-web dev
```

Open `http://localhost:3000` and select **Launch instant demo**. The web app asks staging for a
15-minute room, creates the demo lot, starts it, and connects realtime updates. Manual API URLs,
auction IDs, and JWTs remain available under **Room setup → Advanced setup**. See
[`apps/web/README.md`](./apps/web/README.md) for the complete browser workflow.

Every active room has a canonical `/auctions/{auctionId}` URL. Select **Open another bidder** to
open the same auction in a fresh tab with a newly signed bidder identity. The temporary `/join`
route mints that identity, then replaces itself with the canonical auction URL.

Run every local gate:

```bash
pnpm check
```

That checks generated Cloudflare bindings, TypeScript, type-aware lint, formatting, OpenAPI drift,
Workers-runtime tests, the web build, and production plus staging deployment dry-runs.

Deploy and run the destructive integration suite against staging:

```bash
pnpm deploy:staging
pnpm test:production -- https://cloudflare-live-auction-staging.<account>.workers.dev
```

The suite exercises JWT rejection, request correlation, schema/path/body limits, creation replay, exact historical idempotency, key conflicts, a 24-way contending bid burst, minimum bids, WebSocket snapshot/fanout, ordered history, role enforcement, cancellation, anti-sniping, alarm close, and object isolation. Test auction records are intentionally retained because the public API has no destructive delete operation.

Each deployed run writes `artifacts/integration-report.html`. Open it in a browser to see the architecture, per-check timings, and authoritative auction event timeline. Use `--report=/another/path.html` to change the output or `--no-report` to disable it.

Production is the root Wrangler environment:

```bash
pnpm deploy
curl https://cloudflare-live-auction.<account>.workers.dev/health
curl https://cloudflare-live-auction.<account>.workers.dev/openapi.json
```

Use staging for mutation-heavy verification. A production smoke check should remain read-only unless creating retained production test records is intentional.

The instant-demo route is explicitly disabled in production. Staging enables it with `DEMO_MODE`
and stores the matching private signing JWK as an encrypted Worker secret:

```bash
pnpm exec wrangler secret put DEMO_AUTH_PRIVATE_JWK --env staging
```

## Authentication and key rotation

The checked-in JWKS plus ignored local private key are appropriate only for this working model. Before real users, point `AUTH_JWKS_URL` at an OIDC provider's HTTPS JWKS and remove `AUTH_JWKS_JSON`. The issuer must provide the signed `role` claim expected by this API, or the Worker must map verified identity/group claims to application roles.

To rotate the demo key:

```bash
pnpm auth:keygen
```

Copy the printed `wranglerValue` into both configured environments, deploy staging, run the integration suite, then deploy production. Keep the old public key in the JWKS during a grace window if already-issued tokens must remain valid. Never commit `.auction-auth-private.jwk`.

## Cloudflare tradeoffs

This design is compact because Durable Objects provide the single-writer, SQLite, alarm, and WebSocket lifecycle in one platform. The costs are real:

- one hot auction remains limited by one authority object's sequential throughput;
- Durable Objects have a platform-specific programming and migration model, increasing vendor lock-in;
- an object's physical placement can add latency for globally distributed bidders;
- rate-limit bindings are intentionally permissive and eventually consistent, so auction correctness must never depend on them;
- WebSocket fanout still needs capacity planning, cursor recovery, and overload behavior despite hibernation;
- alarms are at-least-once/retry-oriented, so close must remain idempotent;
- local Miniflare tests cannot replace deployed staging tests for routing, alarms, limits, and WebSocket behavior.

Video, searchable catalog, payments, moderation, and settlement are deliberately outside the bid transaction. A production decomposition can add Cloudflare Stream, D1, Queues, and Workflows without weakening the per-auction ordering boundary. See [`SYSTEM_DESIGN.md`](./SYSTEM_DESIGN.md) for the interview walkthrough.
