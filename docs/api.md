# API guide

The API contract is defined by Zod schemas in [`src/model.ts`](../src/model.ts), exposed as OpenAPI
YAML in [`openapi.yaml`](../openapi.yaml), and served as JSON at `/openapi.json` by the Worker. The
OpenAPI document is the complete reference for parameters and response schemas; this guide explains
the behavior clients need to handle.

## Authentication and roles

All `/v1/auctions/...` routes require a signed JWT. The API verifies its signature, issuer,
audience, expiry, and algorithm (`ES256` or `RS256`). The token needs a `sub` claim and a `role`
claim of `seller`, `bidder`, or `viewer`. An optional `auctionId` claim restricts the token to that
auction. Configure the trusted issuer and keys on the Worker; see [Deployment](deployment.md).

| Role     | Allowed commands                                        |
| -------- | ------------------------------------------------------- |
| `seller` | Create, start, close, and cancel an auction             |
| `bidder` | Place bids                                              |
| `viewer` | Read auction state and history, and subscribe to events |

All three roles can read and subscribe. Send REST credentials as `Authorization: Bearer <JWT>`. A
WebSocket handshake sends the token in its subprotocol list because browser WebSocket APIs cannot
set an Authorization header:

```text
Sec-WebSocket-Protocol: auction.v1, auth.<JWT>
```

Demo-session routes are public only when `DEMO_MODE` is `enabled`. Demo JWTs are scoped to one
auction and expire after 15 minutes. The bidder join route only issues a credential for a matching,
live demo auction. The [README](../README.md) links the staging API and demo.

## Commands and retries

Start, bid, close, and cancel requests require an `Idempotency-Key` header. Use the same key when
retrying the same operation after a timeout or lost response. The API stores the original result by
actor and key, so an exact retry returns the saved response with `replayed: true`. Reusing a key
with different action data returns an error. Use a new unique key for a new action.

The seller can close a live auction only after its server deadline; an early close returns
`409 AUCTION_NOT_ENDED`. Alarms, reads, and bids also close overdue auctions. A new close key after
closure returns `ALREADY_CLOSED`; retry a successful close with its original key to replay it.

A bid plus the auction's minimum increment must stay within JavaScript's safe-integer range
(`Number.MAX_SAFE_INTEGER` cents). A higher bid returns `409 BID_TOO_HIGH` without changing the
auction, history, or retry record; a bid whose next minimum equals the limit is accepted.

## Example REST flow

Set `API`, `AUCTION_ID`, `SELLER_TOKEN`, and `BIDDER_TOKEN` in your shell first. Tokens must be
issued by an authority trusted by that API environment. Every command key in this example is unique
for its action.

```sh
curl -sS -X PUT "$API/v1/auctions/$AUCTION_ID" \
  -H "Authorization: Bearer $SELLER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"title":"Vintage camera","currency":"USD","startPriceCents":10000,"minIncrementCents":500,"durationSeconds":300,"antiSnipeWindowSeconds":10,"extensionSeconds":10}'

curl -sS -X POST "$API/v1/auctions/$AUCTION_ID/start" \
  -H "Authorization: Bearer $SELLER_TOKEN" \
  -H 'Idempotency-Key: start-camera-001'

curl -sS -X POST "$API/v1/auctions/$AUCTION_ID/bids" \
  -H "Authorization: Bearer $BIDDER_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: bid-camera-001' \
  --data '{"amountCents":10000}'

curl -sS "$API/v1/auctions/$AUCTION_ID/history?afterSequence=0&limit=50" \
  -H "Authorization: Bearer $BIDDER_TOKEN"
```

Creating an auction with the same ID and same settings returns its existing result. Reusing the ID
with different settings returns `AUCTION_ALREADY_EXISTS`.

## Realtime updates and recovery

Connect to `/v1/auctions/{auctionId}/events?afterSequence={cursor}` using the `auction.v1` and
`auth.<JWT>` subprotocols. On connect, the server sends an `auction.snapshot` message with the
current auction, recent missed events, a cursor, and a `resyncRequired` flag. Subsequent
`auction.event` messages include the latest auction snapshot and one ordered event. Event sequence
numbers are per-auction and increase as changes commit.

Remember the greatest cursor received. After reconnect, supply it as `afterSequence`; ignore event
sequences already applied. If a snapshot says `resyncRequired: true`, fetch
`/history?afterSequence=<last-applied-sequence>` and apply those events before continuing. The
history endpoint is paginated: advance `afterSequence` to the last applied event and repeat until
caught up. Send `ping` to receive `pong` for a connection heartbeat.

## Errors

An API error has `ok: false` and an `error` containing `status`, `code`, and `message`. The HTTP
status matches `error.status`; see the OpenAPI contract for the schema.

Responses include an `X-Request-Id` header. Send a valid UUID as `X-Request-Id` to correlate your
own logs with the Worker request log. Common failures include `UNAUTHENTICATED`, `FORBIDDEN`,
`AUCTION_SCOPE_MISMATCH`, `RATE_LIMITED`, `INVALID_BODY`, `IDEMPOTENCY_KEY_REUSED`, and
`AUCTION_NOT_FOUND`.
