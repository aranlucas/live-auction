import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuctionView } from "cloudflare-live-auction/model";
import { useAuctionRoom } from "../src/hooks/use-auction-room";
import { type TestRoomConfig } from "../src/lib/auction-api";

const roomConfig: TestRoomConfig = {
  apiBaseUrl: "https://auction.test",
  auctionId: "camera",
  viewerToken: "local-test-token",
  sellerToken: "",
  bidderToken: "",
};

function auction(version: number, id = "camera"): AuctionView {
  return {
    id,
    sellerId: "seller",
    title: "Camera",
    currency: "USD",
    state: "LIVE",
    startPriceCents: 1000,
    currentPriceCents: version * 1000,
    nextMinimumBidCents: version * 1000 + 100,
    minIncrementCents: 100,
    leaderId: "bidder",
    bidCount: version - 1,
    version,
    durationSeconds: 60,
    antiSnipeWindowSeconds: 10,
    extensionSeconds: 10,
    startsAt: 1000,
    endsAt: 61000 + version * 1000,
    closedAt: null,
    winnerId: null,
  };
}

// The real hook and socket library run against these local transport adapters.
class ScriptedSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: ScriptedSocket[] = [];
  readyState = ScriptedSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send = vi.fn();

  constructor(readonly url: string) {
    super();
    ScriptedSocket.instances.push(this);
  }

  open() {
    this.readyState = ScriptedSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  close() {
    this.readyState = ScriptedSocket.CLOSED;
  }

  receive(value: unknown) {
    const event = new MessageEvent("message", { data: JSON.stringify(value) });
    Object.defineProperty(event, "target", { value: this });
    this.onmessage?.(event);
  }

  snapshot(value: AuctionView) {
    this.receive({
      type: "auction.snapshot",
      auction: value,
      events: [],
      cursor: value.version,
      resyncRequired: false,
    });
  }
}

interface PendingRead {
  url: URL;
  signal: AbortSignal | null | undefined;
  resolve: (response: Response) => void;
}

let pending: PendingRead[];
let client: QueryClient;
let root: Root;
let container: HTMLDivElement;
let room: ReturnType<typeof useAuctionRoom>;

function Probe({ config }: { config: TestRoomConfig }) {
  room = useAuctionRoom(config);
  return createElement(
    "output",
    { "data-fetching": room.auctionQuery.isFetching, "data-error": room.auctionQuery.isError },
    JSON.stringify(room.auction),
  );
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(config = roomConfig) {
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe, { config })));
  });
  await flush();
}

async function complete(read: PendingRead, value: AuctionView) {
  await act(async () => {
    read.resolve(Response.json({ ok: true, auction: value }));
  });
  await flush();
}

async function connect(version = 7) {
  await render();
  await complete(pending.shift()!, auction(version));
  await act(async () => {
    ScriptedSocket.instances.at(-1)!.open();
  });
  return ScriptedSocket.instances.at(-1)!;
}

async function snapshot(socket: ScriptedSocket, value: AuctionView) {
  await act(async () => socket.snapshot(value));
  await flush();
}

function visibleAuction(): AuctionView | null {
  return JSON.parse(container.textContent || "null") as AuctionView | null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", ScriptedSocket);
  ScriptedSocket.instances = [];
  pending = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: URL, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/history")) {
        return Promise.resolve(Response.json({ ok: true, auction: auction(7), events: [] }));
      }
      // Intentionally allow replies after abort, to prove cancelled work cannot commit.
      return new Promise<Response>((resolve) => {
        pending.push({ url, signal: init?.signal, resolve });
      });
    }),
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe("useAuctionRoom snapshot ordering", () => {
  it("keeps a newer socket price and deadline after a delayed HTTP response", async () => {
    const socket = await connect();
    const poll = room.auctionQuery.refetch();
    await snapshot(socket, auction(8));
    await complete(pending.shift()!, auction(7));
    await poll;
    expect(visibleAuction()).toEqual(auction(8));
    expect(room.auctionQuery.isFetching).toBe(false);
  });

  it("rejects older and duplicate socket snapshots after a newer HTTP result", async () => {
    const socket = await connect(9);
    await snapshot(socket, auction(8));
    await snapshot(socket, { ...auction(9), currentPriceCents: 1000, endsAt: 1000 });
    expect(visibleAuction()).toEqual(auction(9));
  });

  it("repairs missed fanout with a later read and never reopens a cancelled auction", async () => {
    const socket = await connect();
    const poll = room.auctionQuery.refetch();
    const cancelled: AuctionView = { ...auction(10), state: "CANCELLED" };
    await complete(pending.shift()!, cancelled);
    await poll;
    await snapshot(socket, auction(9));
    expect(visibleAuction()).toEqual(cancelled);
  });

  it.each([
    ["auction", { ...roomConfig, auctionId: "watch" }, "watch"],
    ["API origin", { ...roomConfig, apiBaseUrl: "https://other.test" }, "camera"],
    ["credentials", { ...roomConfig, viewerToken: "another-local-token" }, "camera"],
  ])("does not replay a retained socket snapshot when switching %s", async (_, config, id) => {
    const oldSocket = await connect();
    await snapshot(oldSocket, auction(20));
    await render(config);
    expect(visibleAuction()).toBeNull();
    await complete(pending.shift()!, auction(1, id));
    expect(visibleAuction()).toEqual(auction(1, id));
    await snapshot(oldSocket, auction(21));
    expect(visibleAuction()).toEqual(auction(1, id));
  });

  it("reconnects before accepting messages for already cached credentials", async () => {
    const oldSocket = await connect();
    const nextConfig = { ...roomConfig, viewerToken: "cached-local-token" };
    client.setQueryData(
      ["auction", nextConfig.apiBaseUrl, nextConfig.auctionId, nextConfig.viewerToken],
      { ok: true, auction: auction(1) },
    );
    await render(nextConfig);
    expect(ScriptedSocket.instances).toHaveLength(2);
    expect(oldSocket.readyState).toBe(ScriptedSocket.CLOSED);
    await snapshot(oldSocket, auction(50));
    expect(visibleAuction()).toEqual(auction(1));
  });

  it("ignores malformed and heartbeat messages", async () => {
    const socket = await connect();
    await act(async () => {
      socket.receive("pong");
      socket.receive({ type: "auction.snapshot", auction: { version: 99 } });
    });
    await flush();
    expect(visibleAuction()).toEqual(auction(7));
  });

  it("ignores a valid snapshot for another auction on the current socket", async () => {
    const socket = await connect();
    await snapshot(socket, auction(50, "another-auction"));
    expect(visibleAuction()).toEqual(auction(7));
  });

  it("preserves socket progress on cancellation and ignores the aborted HTTP reply", async () => {
    const socket = await connect();
    const poll = room.auctionQuery.refetch();
    const cancelledRead = pending.shift()!;
    await snapshot(socket, auction(8));
    await act(async () => client.cancelQueries({ queryKey: ["auction"] }));
    expect(cancelledRead.signal?.aborted).toBe(true);
    await complete(cancelledRead, auction(99));
    await poll;
    expect(visibleAuction()).toEqual(auction(8));
    const nextPoll = room.auctionQuery.refetch();
    await complete(pending.shift()!, auction(9));
    await nextPoll;
    expect(visibleAuction()).toEqual(auction(9));
  });

  it("aborts reads on room changes without writing the late result into the new room", async () => {
    await connect();
    const poll = room.auctionQuery.refetch();
    const oldRead = pending.shift()!;
    await render({ ...roomConfig, auctionId: "watch" });
    expect(oldRead.signal?.aborted).toBe(true);
    await complete(pending.shift()!, auction(1, "watch"));
    await complete(oldRead, auction(99));
    await poll;
    expect(visibleAuction()).toEqual(auction(1, "watch"));
  });

  it("keeps the last snapshot on HTTP failure and advances on the next successful read", async () => {
    const socket = await connect();
    const poll = room.auctionQuery.refetch();
    await snapshot(socket, auction(8));
    await act(async () => {
      pending.shift()!.resolve(
        Response.json({
          ok: false,
          error: { status: 503, code: "UNAVAILABLE", message: "Retry" },
        }),
      );
      await poll;
    });
    await flush();
    expect(visibleAuction()).toEqual(auction(8));
    expect(room.auctionQuery.isError).toBe(true);
    const nextPoll = room.auctionQuery.refetch();
    await complete(pending.shift()!, auction(9));
    await nextPoll;
    expect(visibleAuction()).toEqual(auction(9));
  });
});
