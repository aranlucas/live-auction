import { env, exports } from "cloudflare:workers";
import { listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Auction } from "../src/auction";
import {
  auctionActionResultSchema,
  demoBidderSessionResultSchema,
  demoSessionResultSchema,
  historyResultSchema,
  operationFailureSchema,
  readResultSchema,
  type AuctionActionResult,
  type ReadResult,
} from "../src/model";
import { actorHeaders, tokenFor } from "./auth";

const sellerHeaders = async (key?: string): Promise<Record<string, string>> => ({
  "Content-Type": "application/json",
  ...(await actorHeaders("seller-1", "seller", key)),
});

const bidderHeaders = async (bidderId: string, key: string): Promise<Record<string, string>> => ({
  "Content-Type": "application/json",
  ...(await actorHeaders(bidderId, "bidder", key)),
});

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (
    path.startsWith("/v1/auctions/") &&
    !headers.has("Authorization") &&
    !headers.has("Sec-WebSocket-Protocol")
  ) {
    const viewer = await actorHeaders("test-viewer", "viewer");
    headers.set("Authorization", viewer.Authorization);
  }
  return exports.default.fetch(new Request(`https://auction.test${path}`, { ...init, headers }));
}

async function createAndStart(id: string, overrides: Record<string, number> = {}): Promise<void> {
  const create = await request(`/v1/auctions/${id}`, {
    method: "PUT",
    headers: await sellerHeaders(),
    body: JSON.stringify({
      title: "Vintage camera",
      currency: "USD",
      startPriceCents: 1_000,
      minIncrementCents: 100,
      durationSeconds: 60,
      antiSnipeWindowSeconds: 10,
      extensionSeconds: 10,
      ...overrides,
    }),
  });
  expect(create.status).toBe(201);

  const start = await request(`/v1/auctions/${id}/start`, {
    method: "POST",
    headers: await sellerHeaders(`start-${id}`),
  });
  expect(start.status).toBe(200);
}

async function readActionResult(response: Response): Promise<AuctionActionResult> {
  return auctionActionResultSchema.parse(await response.json());
}

async function readAuction(response: Response): Promise<ReadResult> {
  return readResultSchema.parse(await response.json());
}

describe("live auction API", () => {
  it("allows the configured web app to make credentialed API requests", async () => {
    const response = await exports.default.fetch(
      new Request("https://auction.test/v1/auctions/browser-room", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe("X-Request-Id");

    const disallowed = await exports.default.fetch(
      new Request("https://auction.test/v1/auctions/browser-room", {
        method: "OPTIONS",
        headers: {
          Origin: "https://attacker.test",
          "Access-Control-Request-Method": "GET",
        },
      }),
    );
    expect(disallowed.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const demoPreflight = await exports.default.fetch(
      new Request("https://auction.test/v1/demo-session", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "POST",
        },
      }),
    );
    expect(demoPreflight.status).toBe(204);
    expect(demoPreflight.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
  });

  it("creates a short-lived demo room whose tokens cannot cross auction boundaries", async () => {
    const sessionResponse = await request("/v1/demo-session", {
      method: "POST",
    });
    expect(sessionResponse.status).toBe(201);
    expect(sessionResponse.headers.get("Cache-Control")).toBe("no-store");
    const session = demoSessionResultSchema.parse(await sessionResponse.json());
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    expect(session.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1_000) + 14 * 60);
    const create = await request(`/v1/auctions/${session.auctionId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${session.sellerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "Scoped demo camera",
        currency: "USD",
        startPriceCents: 1_000,
        minIncrementCents: 100,
        durationSeconds: 60,
        antiSnipeWindowSeconds: 10,
        extensionSeconds: 10,
      }),
    });
    expect(create.status).toBe(201);

    const draftJoinResponse = await request(`/v1/demo-session/${session.auctionId}/bidder`, {
      method: "POST",
    });
    expect(draftJoinResponse.status).toBe(409);
    const draftJoin = demoBidderSessionResultSchema.parse(await draftJoinResponse.json());
    expect(draftJoin.ok).toBe(false);
    if (!draftJoin.ok) expect(draftJoin.error.code).toBe("DEMO_AUCTION_NOT_LIVE");

    const start = await request(`/v1/auctions/${session.auctionId}/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.sellerToken}`,
        "Idempotency-Key": "start-scoped-demo",
      },
    });
    expect(start.status).toBe(200);

    const firstBidderResponse = await request(`/v1/demo-session/${session.auctionId}/bidder`, {
      method: "POST",
    });
    const secondBidderResponse = await request(`/v1/demo-session/${session.auctionId}/bidder`, {
      method: "POST",
    });
    expect(firstBidderResponse.status).toBe(201);
    expect(secondBidderResponse.status).toBe(201);
    const firstBidder = demoBidderSessionResultSchema.parse(await firstBidderResponse.json());
    const secondBidder = demoBidderSessionResultSchema.parse(await secondBidderResponse.json());
    expect(firstBidder.ok && secondBidder.ok).toBe(true);
    if (!firstBidder.ok || !secondBidder.ok) return;
    expect(firstBidder.bidderId).not.toBe(secondBidder.bidderId);

    const firstBid = await request(`/v1/auctions/${session.auctionId}/bids`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firstBidder.bidderToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "first-guest-bid",
      },
      body: JSON.stringify({ amountCents: 1_000 }),
    });
    const secondBid = await request(`/v1/auctions/${session.auctionId}/bids`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secondBidder.bidderToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "second-guest-bid",
      },
      body: JSON.stringify({ amountCents: 1_100 }),
    });
    expect(firstBid.status).toBe(200);
    expect(secondBid.status).toBe(200);

    const objectsBeforeMismatch = await listDurableObjectIds(env.AUCTIONS);
    const mismatch = await request("/v1/auctions/a-different-demo-room", {
      headers: { Authorization: `Bearer ${session.viewerToken}` },
    });
    expect(mismatch.status).toBe(403);
    const failure = operationFailureSchema.parse(await mismatch.json());
    expect(failure.error.code).toBe("AUCTION_SCOPE_MISMATCH");
    expect(await listDurableObjectIds(env.AUCTIONS)).toHaveLength(objectsBeforeMismatch.length);
  });

  it("does not mint demo bidders for an auction created by an ordinary seller", async () => {
    const auctionId = "demo-untrusted-seller";
    await createAndStart(auctionId);

    const response = await request(`/v1/demo-session/${auctionId}/bidder`, {
      method: "POST",
    });
    expect(response.status).toBe(404);
    const result = demoBidderSessionResultSchema.parse(await response.json());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DEMO_AUCTION_NOT_FOUND");
  });

  it("validates path, query, and body inputs at the Hono edge", async () => {
    const badId = await request("/v1/auctions/not%20safe");
    expect(badId.status).toBe(400);

    const badBody = await request("/v1/auctions/invalid-body", {
      method: "PUT",
      headers: await sellerHeaders(),
      body: JSON.stringify({
        title: "Camera",
        currency: "usd",
        startPriceCents: 1_000,
        minIncrementCents: 100,
        durationSeconds: 60,
        antiSnipeWindowSeconds: 10,
        extensionSeconds: 0,
        unexpected: true,
      }),
    });
    expect(badBody.status).toBe(400);

    const malformedJson = await request("/v1/auctions/malformed-json", {
      method: "PUT",
      headers: await sellerHeaders(),
      body: "{",
    });
    expect(malformedJson.status).toBe(400);

    const oversizedBody = await request("/v1/auctions/oversized-body", {
      method: "PUT",
      headers: await sellerHeaders(),
      body: JSON.stringify({ title: "x".repeat(17_000) }),
    });
    expect(oversizedBody.status).toBe(413);

    await createAndStart("invalid-query");
    const badQuery = await request("/v1/auctions/invalid-query/history?limit=101");
    expect(badQuery.status).toBe(400);
  });

  it("runs the create, start, bid, replay, and history flow", async () => {
    const id = "happy-path";
    await createAndStart(id);

    const bidResponse = await request(`/v1/auctions/${id}/bids`, {
      method: "POST",
      headers: await bidderHeaders("bidder-1", "bid-1"),
      body: JSON.stringify({ amountCents: 1_000 }),
    });
    expect(bidResponse.status).toBe(200);
    const bid = await readActionResult(bidResponse);
    expect(bid.ok).toBe(true);
    if (!bid.ok) return;
    expect(bid.auction.currentPriceCents).toBe(1_000);
    expect(bid.auction.nextMinimumBidCents).toBe(1_100);
    expect(bid.auction.leaderId).toBe("bidder-1");
    expect(bid.replayed).toBe(false);

    const newerBid = await readActionResult(
      await request(`/v1/auctions/${id}/bids`, {
        method: "POST",
        headers: await bidderHeaders("bidder-2", "bid-2"),
        body: JSON.stringify({ amountCents: 1_100 }),
      }),
    );
    expect(newerBid.ok && newerBid.auction.currentPriceCents).toBe(1_100);

    const replay = await readActionResult(
      await request(`/v1/auctions/${id}/bids`, {
        method: "POST",
        headers: await bidderHeaders("bidder-1", "bid-1"),
        body: JSON.stringify({ amountCents: 1_000 }),
      }),
    );
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.replayed).toBe(true);
      expect(replay.event.sequence).toBe(bid.event.sequence);
      expect(replay.auction.currentPriceCents).toBe(1_000);
      expect(replay.auction.bidCount).toBe(1);
    }

    const current = await readAuction(await request(`/v1/auctions/${id}`));
    expect(current.ok && current.auction.currentPriceCents).toBe(1_100);

    const historyResponse = await request(`/v1/auctions/${id}/history?afterSequence=0`);
    expect(historyResponse.status).toBe(200);
    const history = historyResultSchema.parse(await historyResponse.json());
    expect(history.ok && history.events).toHaveLength(4);
  });

  it("rejects a low bid and reuse of an idempotency key with a new amount", async () => {
    const id = "bid-validation";
    await createAndStart(id);

    const low = await readActionResult(
      await request(`/v1/auctions/${id}/bids`, {
        method: "POST",
        headers: await bidderHeaders("bidder-1", "low"),
        body: JSON.stringify({ amountCents: 999 }),
      }),
    );
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.error.code).toBe("BID_TOO_LOW");

    await request(`/v1/auctions/${id}/bids`, {
      method: "POST",
      headers: await bidderHeaders("bidder-1", "stable-key"),
      body: JSON.stringify({ amountCents: 1_000 }),
    });
    const reused = await readActionResult(
      await request(`/v1/auctions/${id}/bids`, {
        method: "POST",
        headers: await bidderHeaders("bidder-1", "stable-key"),
        body: JSON.stringify({ amountCents: 1_500 }),
      }),
    );
    expect(reused.ok).toBe(false);
    if (!reused.ok) expect(reused.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("serializes contending bids so only one equal bid wins", async () => {
    const id = "contention";
    await createAndStart(id);

    const [first, second] = await Promise.all([
      request(`/v1/auctions/${id}/bids`, {
        method: "POST",
        headers: await bidderHeaders("bidder-a", "race-a"),
        body: JSON.stringify({ amountCents: 1_000 }),
      }),
      request(`/v1/auctions/${id}/bids`, {
        method: "POST",
        headers: await bidderHeaders("bidder-b", "race-b"),
        body: JSON.stringify({ amountCents: 1_000 }),
      }),
    ]);

    expect([first.status, second.status].sort((left, right) => left - right)).toEqual([200, 409]);
    const state = await readAuction(await request(`/v1/auctions/${id}`));
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.auction.bidCount).toBe(1);
      expect(["bidder-a", "bidder-b"]).toContain(state.auction.leaderId);
    }
  });

  it("extends a deadline for a last-second bid", async () => {
    const id = "anti-snipe";
    await createAndStart(id, {
      durationSeconds: 5,
      antiSnipeWindowSeconds: 10,
      extensionSeconds: 15,
    });
    const before = await readAuction(await request(`/v1/auctions/${id}`));
    expect(before.ok).toBe(true);
    if (!before.ok || before.auction.endsAt === null) return;

    const accepted = await readActionResult(
      await request(`/v1/auctions/${id}/bids`, {
        method: "POST",
        headers: await bidderHeaders("bidder-1", "extend-1"),
        body: JSON.stringify({ amountCents: 1_000 }),
      }),
    );
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.auction.endsAt).toBe(before.auction.endsAt + 15_000);
      await runInDurableObject(env.AUCTIONS.getByName(id), async (_instance, state) => {
        expect(await state.storage.getAlarm()).toBe(accepted.auction.endsAt);
      });
    }
  });

  it("replays an accepted bid before lazily closing an overdue auction", async () => {
    const id = "late-idempotent-retry";
    await createAndStart(id);
    const original = await readActionResult(
      await request(`/v1/auctions/${id}/bids`, {
        method: "POST",
        headers: await bidderHeaders("retry-bidder", "stable-retry"),
        body: JSON.stringify({ amountCents: 1_000 }),
      }),
    );
    expect(original.ok).toBe(true);

    const stub = env.AUCTIONS.getByName(id);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE auction SET ends_at = ?", Date.now() - 1);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const replayResponse = await request(`/v1/auctions/${id}/bids`, {
      method: "POST",
      headers: await bidderHeaders("retry-bidder", "stable-retry"),
      body: JSON.stringify({ amountCents: 1_000 }),
    });
    expect(replayResponse.status).toBe(200);
    const replay = await readActionResult(replayResponse);
    expect(replay.ok && replay.replayed).toBe(true);
    if (replay.ok && original.ok) expect(replay.auction).toEqual(original.auction);

    const newLateBid = await readActionResult(
      await request(`/v1/auctions/${id}/bids`, {
        method: "POST",
        headers: await bidderHeaders("late-bidder", "new-late-command"),
        body: JSON.stringify({ amountCents: 2_000 }),
      }),
    );
    expect(newLateBid.ok).toBe(false);
    if (!newLateBid.ok)
      expect(["AUCTION_ENDED", "AUCTION_NOT_LIVE"]).toContain(newLateBid.error.code);
  });

  it("closes exactly once when the alarm runs and rejects late bids", async () => {
    const id = "alarm-close";
    await createAndStart(id);
    await request(`/v1/auctions/${id}/bids`, {
      method: "POST",
      headers: await bidderHeaders("winner", "winning-bid"),
      body: JSON.stringify({ amountCents: 1_000 }),
    });

    const stub = env.AUCTIONS.getByName(id);
    await runInDurableObject(stub, async (instance: Auction, state) => {
      expect(instance).toBeInstanceOf(Auction);
      state.storage.sql.exec("UPDATE auction SET ends_at = ?", Date.now() - 1);
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const state = await readAuction(await request(`/v1/auctions/${id}`));
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.auction.state).toBe("CLOSED");
    expect(state.auction.winnerId).toBe("winner");
    const closedVersion = state.auction.version;

    expect(await runDurableObjectAlarm(stub)).toBe(false);
    const after = await readAuction(await request(`/v1/auctions/${id}`));
    if (after.ok) expect(after.auction.version).toBe(closedVersion);

    const late = await readActionResult(
      await request(`/v1/auctions/${id}/bids`, {
        method: "POST",
        headers: await bidderHeaders("late", "late-bid"),
        body: JSON.stringify({ amountCents: 2_000 }),
      }),
    );
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe("AUCTION_NOT_LIVE");
  });

  it("requires roles and prevents a seller from closing early", async () => {
    const id = "authorization";
    await createAndStart(id);

    const unauthenticated = await exports.default.fetch(
      new Request(`https://auction.test/v1/auctions/${id}/bids`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "missing-user",
        },
        body: JSON.stringify({ amountCents: 1_000 }),
      }),
    );
    expect(unauthenticated.status).toBe(401);

    const wrongRole = await request(`/v1/auctions/${id}/close`, {
      method: "POST",
      headers: await bidderHeaders("bidder-1", "wrong-role"),
    });
    expect(wrongRole.status).toBe(403);

    const missingIdempotencyKey = await request(`/v1/auctions/${id}/close`, {
      method: "POST",
      headers: await sellerHeaders(),
    });
    expect(missingIdempotencyKey.status).toBe(400);

    const earlyClose = await readActionResult(
      await request(`/v1/auctions/${id}/close`, {
        method: "POST",
        headers: await sellerHeaders("too-soon"),
      }),
    );
    expect(earlyClose.ok).toBe(false);
    if (!earlyClose.ok) expect(earlyClose.error.code).toBe("AUCTION_NOT_ENDED");
  });

  it("rejects forged identity before allocating an auction object", async () => {
    const objectsBefore = await listDurableObjectIds(env.AUCTIONS);
    const forged = await exports.default.fetch(
      new Request("https://auction.test/v1/auctions/forged-missing", {
        headers: {
          "X-User-Id": "seller-1",
          "X-User-Role": "seller",
        },
      }),
    );
    expect(forged.status).toBe(401);
    expect(await listDurableObjectIds(env.AUCTIONS)).toHaveLength(objectsBefore.length);

    const wrongIssuer = await tokenFor("seller-1", "seller", {
      issuer: "https://attacker.test",
    });
    const invalidJwt = await exports.default.fetch(
      new Request("https://auction.test/v1/auctions/forged-missing", {
        headers: { Authorization: `Bearer ${wrongIssuer}` },
      }),
    );
    expect(invalidJwt.status).toBe(401);
    expect(await listDurableObjectIds(env.AUCTIONS)).toHaveLength(objectsBefore.length);
  });

  it("returns request correlation and generated OpenAPI", async () => {
    const requestId = crypto.randomUUID();
    const health = await request("/health", {
      headers: { "X-Request-Id": requestId },
    });
    expect(health.headers.get("X-Request-Id")).toBe(requestId);

    const document = await (
      await request("/openapi.json")
    ).json<{
      openapi: string;
      paths: Record<string, unknown>;
      components: {
        schemas: Record<string, unknown>;
        securitySchemes: Record<string, unknown>;
      };
    }>();
    expect(document.openapi).toBe("3.1.0");
    expect(document.paths["/v1/auctions/{auctionId}/bids"]).toBeDefined();
    expect(document.paths["/v1/demo-session"]).toBeDefined();
    expect(document.paths["/v1/demo-session/{auctionId}/bidder"]).toBeDefined();
    expect(document.components.schemas.AuctionEvent).toBeDefined();
    expect(document.components.schemas.AuctionActionSuccess).toBeDefined();
    expect(document.components.securitySchemes.bearerAuth).toBeDefined();
  });

  it("applies numbered migrations and database invariants", async () => {
    const id = "schema-invariants";
    await createAndStart(id);
    await runInDurableObject(env.AUCTIONS.getByName(id), async (_instance, state) => {
      const versions = state.storage.sql
        .exec<{ id: number }>("SELECT id FROM _sql_schema_migrations ORDER BY id")
        .toArray()
        .map((row) => row.id);
      expect(versions).toEqual([1, 2, 3, 4]);
      const idempotencyRecord = state.storage.sql
        .exec<{ response_json: string | null }>(
          "SELECT response_json FROM idempotency_records WHERE action_type = 'start'",
        )
        .one();
      expect(idempotencyRecord.response_json).not.toBeNull();
      expect(() => state.storage.sql.exec("UPDATE auction SET start_price_cents = 0")).toThrow(
        /auction invariant violated/,
      );
    });
  });
});
