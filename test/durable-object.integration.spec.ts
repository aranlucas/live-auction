import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  commandResultSchema,
  eventPayloadSchema,
  historyResultSchema,
  readResultSchema,
  realtimeMessageSchema,
} from "../src/model";
import { actorHeaders, websocketProtocols } from "./auth";

const sellerHeaders = async (): Promise<Record<string, string>> => ({
  "Content-Type": "application/json",
  ...(await actorHeaders("seller-integration", "seller")),
});

const commandHeaders = async (
  actorId: string,
  role: "seller" | "bidder",
  key: string,
): Promise<Record<string, string>> => ({
  "Content-Type": "application/json",
  ...(await actorHeaders(actorId, role, key)),
});

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (
    path.startsWith("/v1/auctions/") &&
    !headers.has("Authorization") &&
    !headers.has("Sec-WebSocket-Protocol")
  ) {
    const viewer = await actorHeaders("integration-viewer", "viewer");
    headers.set("Authorization", viewer.Authorization);
  }
  return exports.default.fetch(new Request(`https://auction.test${path}`, { ...init, headers }));
}

async function createDraft(id: string, title = "Integration camera"): Promise<Response> {
  return request(`/v1/auctions/${id}`, {
    method: "PUT",
    headers: await sellerHeaders(),
    body: JSON.stringify({
      title,
      currency: "USD",
      startPriceCents: 1_000,
      minIncrementCents: 100,
      durationSeconds: 60,
      antiSnipeWindowSeconds: 0,
      extensionSeconds: 0,
    }),
  });
}

async function createAndStart(id: string): Promise<void> {
  expect((await createDraft(id)).status).toBe(201);
  const started = await request(`/v1/auctions/${id}/start`, {
    method: "POST",
    headers: await commandHeaders("seller-integration", "seller", `start-${id}`),
  });
  expect(started.status).toBe(200);
}

async function placeBid(
  id: string,
  bidderId: string,
  amountCents: number,
  key: string,
): Promise<Response> {
  return request(`/v1/auctions/${id}/bids`, {
    method: "POST",
    headers: await commandHeaders(bidderId, "bidder", key),
    body: JSON.stringify({ amountCents }),
  });
}

function nextSocketMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for WebSocket message")),
      2_000,
    );
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(String(event.data));
      },
      { once: true },
    );
  });
}

describe("Durable Object integration behavior", () => {
  it("replays identical creation, rejects conflicting creation, and isolates IDs", async () => {
    const id = "create-replay-integration";
    expect((await createDraft(id)).status).toBe(201);

    const replay = commandResultSchema.parse(await (await createDraft(id)).json());
    expect(replay.ok && replay.replayed).toBe(true);

    const conflict = commandResultSchema.parse(
      await (await createDraft(id, "Different camera")).json(),
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("AUCTION_ALREADY_EXISTS");

    const other = readResultSchema.parse(
      await (await request("/v1/auctions/create-replay-integration-other")).json(),
    );
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.code).toBe("AUCTION_NOT_FOUND");
  });

  it("persists state and ordered history across Durable Object eviction", async () => {
    const id = "eviction-persistence-integration";
    await createAndStart(id);
    expect((await placeBid(id, "bidder-a", 1_000, "eviction-bid-a")).status).toBe(200);
    expect((await placeBid(id, "bidder-b", 1_100, "eviction-bid-b")).status).toBe(200);

    await evictDurableObject(env.AUCTIONS.getByName(id));

    const state = readResultSchema.parse(await (await request(`/v1/auctions/${id}`)).json());
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.auction.currentPriceCents).toBe(1_100);
      expect(state.auction.leaderId).toBe("bidder-b");
      expect(state.auction.bidCount).toBe(2);
    }

    const history = historyResultSchema.parse(
      await (await request(`/v1/auctions/${id}/history`)).json(),
    );
    expect(history.ok).toBe(true);
    if (history.ok) expect(history.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("delivers snapshots, events, and ping/pong across WebSocket hibernation", async () => {
    const id = "websocket-eviction-integration";
    await createAndStart(id);

    const response = await request(`/v1/auctions/${id}/events`, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": await websocketProtocols("socket-viewer", "viewer"),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    if (!socket) return;

    const snapshotMessage = nextSocketMessage(socket);
    socket.accept();
    const snapshot = realtimeMessageSchema.parse(JSON.parse(await snapshotMessage));
    expect(snapshot.type).toBe("auction.snapshot");
    expect(snapshot.auction.state).toBe("LIVE");

    await evictDurableObject(env.AUCTIONS.getByName(id));
    for (let shard = 0; shard < 4; shard += 1) {
      await evictDurableObject(env.AUCTION_FANOUT.getByName(`${id}:${shard}`));
    }

    const pong = nextSocketMessage(socket);
    socket.send("ping");
    expect(await pong).toBe("pong");

    const eventMessage = nextSocketMessage(socket);
    expect((await placeBid(id, "socket-bidder", 1_000, "socket-bid")).status).toBe(200);
    const event = realtimeMessageSchema.parse(JSON.parse(await eventMessage));
    expect(event.type).toBe("auction.event");
    if (event.type === "auction.event") {
      expect(event.event.type).toBe("bid.accepted");
      expect(event.auction.leaderId).toBe("socket-bidder");
    }
    socket.close(1000, "test complete");
  });

  it("resumes a WebSocket from an event sequence without a delivery gap", async () => {
    const id = "websocket-resume-integration";
    await createAndStart(id);
    expect((await placeBid(id, "resume-bidder", 1_000, "resume-bid")).status).toBe(200);

    const response = await request(`/v1/auctions/${id}/events?afterSequence=1`, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": await websocketProtocols("resume-viewer", "viewer"),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    if (!socket) return;

    const initial = nextSocketMessage(socket);
    socket.accept();
    const snapshot = realtimeMessageSchema.parse(JSON.parse(await initial));
    expect(snapshot.type).toBe("auction.snapshot");
    if (snapshot.type === "auction.snapshot") {
      expect(snapshot.resyncRequired).toBe(false);
      expect(snapshot.events.map((event) => event.sequence)).toEqual([2, 3]);
      expect(snapshot.cursor).toBe(3);
      expect(snapshot.auction.version).toBe(3);
    }

    const next = nextSocketMessage(socket);
    expect((await placeBid(id, "resume-bidder-2", 1_100, "resume-bid-2")).status).toBe(200);
    const event = realtimeMessageSchema.parse(JSON.parse(await next));
    expect(event.type).toBe("auction.event");
    if (event.type === "auction.event") expect(event.cursor).toBe(4);
    socket.close(1000, "resume complete");
  });

  it("paginates a strictly ordered event log", async () => {
    const id = "history-pagination-integration";
    await createAndStart(id);
    for (let index = 0; index < 5; index += 1) {
      expect(
        (await placeBid(id, `bidder-${index}`, 1_000 + index * 100, `page-bid-${index}`)).status,
      ).toBe(200);
    }

    const firstPage = historyResultSchema.parse(
      await (await request(`/v1/auctions/${id}/history?afterSequence=2&limit=2`)).json(),
    );
    const secondPage = historyResultSchema.parse(
      await (await request(`/v1/auctions/${id}/history?afterSequence=4&limit=10`)).json(),
    );
    expect(firstPage.ok && firstPage.events.map((event) => event.sequence)).toEqual([3, 4]);
    expect(secondPage.ok && secondPage.events.map((event) => event.sequence)).toEqual([5, 6, 7]);
  });

  it("cancels a live auction, removes its alarm, and rejects later bids", async () => {
    const id = "cancel-alarm-integration";
    await createAndStart(id);
    const cancelled = commandResultSchema.parse(
      await (
        await request(`/v1/auctions/${id}/cancel`, {
          method: "POST",
          headers: await commandHeaders("seller-integration", "seller", "cancel-live"),
        })
      ).json(),
    );
    expect(cancelled.ok && cancelled.auction.state).toBe("CANCELLED");
    expect(await runDurableObjectAlarm(env.AUCTIONS.getByName(id))).toBe(false);

    const late = commandResultSchema.parse(
      await (await placeBid(id, "late-bidder", 1_000, "cancelled-late-bid")).json(),
    );
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe("AUCTION_NOT_LIVE");
  });

  it("rejects nested values in persisted event payloads", () => {
    expect(
      eventPayloadSchema.safeParse({
        bidId: "bid-1",
        amountCents: 1_000,
        extended: false,
        endsAt: Date.now(),
      }).success,
    ).toBe(true);
    expect(eventPayloadSchema.safeParse({ nested: { invalid: true } }).success).toBe(false);
  });

  it("serializes a burst of equal bids to one winner", async () => {
    const id = "burst-contention-integration";
    await createAndStart(id);
    const responses = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        placeBid(id, `burst-bidder-${index}`, 1_000, `burst-key-${index}`),
      ),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(31);

    const state = readResultSchema.parse(await (await request(`/v1/auctions/${id}`)).json());
    expect(state.ok && state.auction.bidCount).toBe(1);
  });
});
