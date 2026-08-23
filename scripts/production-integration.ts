import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  commandResultSchema,
  demoBidderSessionResultSchema,
  demoSessionResultSchema,
  healthSchema,
  historyResultSchema,
  operationFailureSchema,
  readResultSchema,
  realtimeMessageSchema,
} from "../src/model";
import { issueToken } from "./auth-support";

interface CheckResult {
  name: string;
  durationMs: number;
  detail: string;
}

const cliArguments = process.argv.slice(2).filter((argument) => argument !== "--");
const suppliedBaseUrl =
  cliArguments.find((argument) => !argument.startsWith("--")) ?? process.env.AUCTION_BASE_URL;
if (!suppliedBaseUrl) {
  throw new Error("Pass the deployed Worker URL or set AUCTION_BASE_URL");
}

const reportArgument = cliArguments.find((argument) => argument.startsWith("--report="));
const reportPath = cliArguments.includes("--no-report")
  ? undefined
  : resolve(
      reportArgument?.slice("--report=".length) ??
        process.env.AUCTION_REPORT_PATH ??
        "artifacts/integration-report.html",
    );

const baseUrl = new URL(suppliedBaseUrl);
const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const auctionIds = {
  live: `integration-live-${runId}`,
  cancelled: `integration-cancelled-${runId}`,
  alarm: `integration-alarm-${runId}`,
  missing: `integration-missing-${runId}`,
};
const checks: CheckResult[] = [];
let activeSocket: WebSocket | undefined;

const authOptions = {
  issuer: process.env.AUCTION_AUTH_ISSUER ?? "https://cloudflare-live-auction.example",
  audience: process.env.AUCTION_AUTH_AUDIENCE ?? "cloudflare-live-auction",
  privateJwkPath: process.env.AUCTION_AUTH_PRIVATE_JWK ?? ".auction-auth-private.jwk",
};
const defaultViewerToken = issueToken("integration-viewer", "viewer", authOptions);

const sellerHeaders = async (key?: string): Promise<Record<string, string>> => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${await issueToken("integration-seller", "seller", authOptions)}`,
  ...(key ? { "Idempotency-Key": key } : {}),
});

const bidderHeaders = async (bidderId: string, key: string): Promise<Record<string, string>> => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${await issueToken(bidderId, "bidder", authOptions)}`,
  "Idempotency-Key": key,
});

const auctionBody = (
  title: string,
  durationSeconds = 60,
  antiSnipeWindowSeconds = 0,
  extensionSeconds = 0,
) => ({
  title,
  currency: "USD",
  startPriceCents: 1_000,
  minIncrementCents: 100,
  durationSeconds,
  antiSnipeWindowSeconds,
  extensionSeconds,
});

async function check<T>(name: string, operation: () => Promise<T>, detail: (value: T) => string) {
  const startedAt = performance.now();
  const value = await operation();
  checks.push({
    name,
    durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    detail: detail(value),
  });
  return value;
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (path.startsWith("/v1/auctions/") && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${await defaultViewerToken}`);
  }
  return fetch(new URL(path, baseUrl), { ...init, headers });
}

async function parseResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  expectedStatus: number,
): Promise<T> {
  assert.equal(response.status, expectedStatus, `${response.url} returned ${response.status}`);
  return schema.parse(await response.json());
}

async function createAuction(id: string, body: ReturnType<typeof auctionBody>) {
  return parseResponse(
    await api(`/v1/auctions/${id}`, {
      method: "PUT",
      headers: await sellerHeaders(),
      body: JSON.stringify(body),
    }),
    commandResultSchema,
    201,
  );
}

async function startAuction(id: string, key: string) {
  return parseResponse(
    await api(`/v1/auctions/${id}/start`, {
      method: "POST",
      headers: await sellerHeaders(key),
    }),
    commandResultSchema,
    200,
  );
}

async function bid(id: string, bidderId: string, key: string, amountCents: number) {
  const response = await api(`/v1/auctions/${id}/bids`, {
    method: "POST",
    headers: await bidderHeaders(bidderId, key),
    body: JSON.stringify({ amountCents }),
  });
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `Bid returned non-JSON response: status=${response.status} content-type=${response.headers.get(
        "Content-Type",
      )} body=${body.slice(0, 300)}`,
    );
  }
  return { response, result: commandResultSchema.parse(parsed) };
}

function webSocketMessages(socket: WebSocket) {
  const queued: string[] = [];
  const waiting: Array<(message: string) => void> = [];
  socket.addEventListener("message", (event) => {
    const message = String(event.data);
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else queued.push(message);
  });
  return {
    next(timeoutMs = 5_000): Promise<string> {
      const queuedMessage = queued.shift();
      if (queuedMessage !== undefined) return Promise.resolve(queuedMessage);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for production WebSocket message")),
          timeoutMs,
        );
        waiting.push((message) => {
          clearTimeout(timeout);
          resolve(message);
        });
      });
    },
  };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Production WebSocket failed")), {
      once: true,
    });
  });
}

async function pollUntilClosed(id: string, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readResultSchema.parse(await (await api(`/v1/auctions/${id}`)).json());
    if (state.ok && state.auction.state === "CLOSED") return state;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Auction ${id} did not close before the integration timeout`);
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function writeIntegrationReport(summary: {
  ok: true;
  baseUrl: string;
  runId: string;
  auctionIds: typeof auctionIds;
  checks: CheckResult[];
  timeline: Array<{
    sequence: number;
    type: string;
    actorId: string;
    occurredAt: number;
    amountCents: number | null;
  }>;
}): Promise<string | undefined> {
  if (!reportPath) return undefined;
  const maximumDuration = Math.max(...summary.checks.map((item) => item.durationMs), 1);
  const checkCards = summary.checks
    .map(
      (item) => `<li class="check">
        <div><span class="status">PASS</span><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.durationMs)} ms</span></div>
        <p>${escapeHtml(item.detail)}</p>
        <i style="--width:${Math.max((item.durationMs / maximumDuration) * 100, 1)}%"></i>
      </li>`,
    )
    .join("");
  const timelineItems = summary.timeline
    .map(
      (item) => `<li class="event">
        <span class="sequence">${item.sequence}</span>
        <div><strong>${escapeHtml(item.type)}</strong><p>${escapeHtml(item.actorId)} · ${escapeHtml(new Date(item.occurredAt).toISOString())}${item.amountCents === null ? "" : ` · ${item.amountCents} cents`}</p></div>
      </li>`,
    )
    .join("");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
<title>Live Auction integration report</title>
<style>
:root{color-scheme:dark;--ink:#f5f7f2;--muted:#a9b2a3;--panel:#151b18;--line:#2c3731;--lime:#b9f36a;--gold:#ffce64}*{box-sizing:border-box}body{margin:0;background:#0b0f0d;color:var(--ink);font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}main{width:min(1080px,calc(100% - 32px));margin:48px auto 80px}header{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:end;border-bottom:1px solid var(--line);padding-bottom:28px}h1{font:700 clamp(30px,5vw,58px)/1 system-ui,sans-serif;margin:8px 0}h2{font:700 22px/1.2 system-ui,sans-serif;margin:0 0 18px}.eyebrow,.status{color:var(--lime);letter-spacing:.12em;font-size:12px}.meta{text-align:right;color:var(--muted)}section{margin-top:40px}.flow{display:grid;grid-template-columns:1fr auto 1.3fr auto 1fr;gap:12px;align-items:center}.node{border:1px solid var(--line);background:var(--panel);padding:18px;border-radius:10px}.node strong{display:block;color:var(--gold);margin-bottom:6px}.arrow{color:var(--lime);font-size:20px}.checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;padding:0}.check{list-style:none;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;overflow:hidden}.check div{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center}.check p,.event p{color:var(--muted);margin:8px 0 0;font-size:12px}.check i{display:block;height:3px;background:var(--lime);width:var(--width);margin-top:14px}.timeline{padding:0;margin:0}.event{list-style:none;display:grid;grid-template-columns:42px 1fr;gap:14px;position:relative;padding-bottom:24px}.event:not(:last-child):before{content:"";position:absolute;left:20px;top:36px;bottom:4px;width:1px;background:var(--line)}.sequence{display:grid;place-items:center;width:42px;height:42px;border-radius:50%;background:var(--gold);color:#171006;font-weight:700}.footer{color:var(--muted);border-top:1px solid var(--line);padding-top:24px}@media(max-width:720px){header{grid-template-columns:1fr}.meta{text-align:left}.flow{grid-template-columns:1fr}.arrow{transform:rotate(90deg);justify-self:center}}
</style></head><body><main>
<header><div><span class="eyebrow">DEPLOYED SYSTEM PROOF</span><h1>Live auction integration</h1><div>${escapeHtml(summary.baseUrl)}</div></div><div class="meta">Run ${escapeHtml(summary.runId)}<br>${summary.checks.length} checks passed</div></header>
<section><h2>Request and event flow</h2><div class="flow"><div class="node"><strong>Clients</strong>JWT-authenticated REST + WebSocket</div><span class="arrow">→</span><div class="node"><strong>Worker + Auction authority</strong>Zod validation, rate limits, ordered SQLite transactions and alarm</div><span class="arrow">→</span><div class="node"><strong>4 fanout shards</strong>Hibernating sockets and cursor recovery</div></div></section>
<section><h2>Integration checks</h2><ol class="checks">${checkCards}</ol></section>
<section><h2>Authoritative event timeline</h2><ol class="timeline">${timelineItems}</ol></section>
<section class="footer">Auction ${escapeHtml(summary.auctionIds.live)} · Generated ${escapeHtml(new Date().toISOString())}</section>
</main></body></html>`;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, html, "utf8");
  return reportPath;
}

async function main(): Promise<void> {
  const health = await check(
    "health endpoint",
    async () => {
      const requestId = crypto.randomUUID();
      const response = await api("/health", {
        headers: { "X-Request-Id": requestId },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("X-Request-Id"), requestId);
      return healthSchema.parse(await response.json());
    },
    (health) => `${health.service} (${health.environment}), correlated request`,
  );

  await check(
    "OpenAPI contract",
    async () => {
      const response = await api("/openapi.json");
      assert.equal(response.status, 200);
      return z
        .object({
          openapi: z.literal("3.1.0"),
          paths: z.record(z.string(), z.unknown()),
        })
        .parse(await response.json());
    },
    (document) => `${Object.keys(document.paths).length} documented paths`,
  );

  await check(
    "instant demo room",
    async () => {
      const sessionResponse = await api("/v1/demo-session", { method: "POST" });
      if (health.environment !== "staging") {
        return parseResponse(sessionResponse, operationFailureSchema, 404);
      }

      const session = await parseResponse(sessionResponse, demoSessionResultSchema, 201);
      assert.equal(session.ok, true);

      await parseResponse(
        await api(`/v1/auctions/${session.auctionId}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${session.sellerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(auctionBody("Instant demo camera")),
        }),
        commandResultSchema,
        201,
      );
      await parseResponse(
        await api(`/v1/auctions/${session.auctionId}/start`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.sellerToken}`,
            "Idempotency-Key": `demo-start-${runId}`,
          },
        }),
        commandResultSchema,
        200,
      );
      const acceptedBid = await parseResponse(
        await api(`/v1/auctions/${session.auctionId}/bids`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.bidderToken}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `demo-bid-${runId}`,
          },
          body: JSON.stringify({ amountCents: 1_000 }),
        }),
        commandResultSchema,
        200,
      );
      assert.equal(acceptedBid.ok, true);
      const joinedBidders = await Promise.all(
        [0, 1].map(async () => {
          const response = await api(`/v1/demo-session/${session.auctionId}/bidder`, {
            method: "POST",
          });
          const result = await parseResponse(response, demoBidderSessionResultSchema, 201);
          assert.equal(result.ok, true);
          return result;
        }),
      );
      assert.notEqual(joinedBidders[0].bidderId, joinedBidders[1].bidderId);
      for (const [index, bidder] of joinedBidders.entries()) {
        await parseResponse(
          await api(`/v1/auctions/${session.auctionId}/bids`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${bidder.bidderToken}`,
              "Content-Type": "application/json",
              "Idempotency-Key": `joined-demo-bid-${index}-${runId}`,
            },
            body: JSON.stringify({ amountCents: 1_100 + index * 100 }),
          }),
          commandResultSchema,
          200,
        );
      }
      const mismatch = await parseResponse(
        await api(`/v1/auctions/demo-mismatch-${runId}`, {
          headers: { Authorization: `Bearer ${session.viewerToken}` },
        }),
        operationFailureSchema,
        403,
      );
      assert.equal(mismatch.error.code, "AUCTION_SCOPE_MISMATCH");
      return session;
    },
    (result) =>
      result.ok
        ? `${result.auctionId}: created, started, three distinct bidders, and scope-isolated`
        : "disabled outside staging",
  );

  await check(
    "forged identity headers rejected",
    async () => {
      const response = await fetch(new URL(`/v1/auctions/${auctionIds.missing}`, baseUrl), {
        headers: { "X-User-Id": "forged", "X-User-Role": "seller" },
      });
      return parseResponse(response, operationFailureSchema, 401);
    },
    (failure) => failure.error.code,
  );

  await check(
    "path validation",
    async () => parseResponse(await api("/v1/auctions/not%20safe"), operationFailureSchema, 400),
    (failure) => failure.error.code,
  );

  const created = await check(
    "create auction",
    () => createAuction(auctionIds.live, auctionBody("Production integration auction")),
    (result) => (result.ok ? `sequence ${result.event.sequence}` : result.error.code),
  );
  assert.equal(created.ok, true);

  await check(
    "idempotent create replay",
    async () => {
      const response = await api(`/v1/auctions/${auctionIds.live}`, {
        method: "PUT",
        headers: await sellerHeaders(),
        body: JSON.stringify(auctionBody("Production integration auction")),
      });
      const result = await parseResponse(response, commandResultSchema, 200);
      assert.equal(result.ok && result.replayed, true);
      return result;
    },
    (result) => (result.ok ? `replayed sequence ${result.event.sequence}` : result.error.code),
  );

  await check(
    "start auction",
    () => startAuction(auctionIds.live, `start-${runId}`),
    (result) => (result.ok ? result.auction.state : result.error.code),
  );

  const socketUrl = new URL(`/v1/auctions/${auctionIds.live}/events`, baseUrl);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  const viewerToken = await defaultViewerToken;
  const socket = new WebSocket(socketUrl, ["auction.v1", `auth.${viewerToken}`]);
  activeSocket = socket;
  const messages = webSocketMessages(socket);
  await waitForOpen(socket);
  const snapshot = realtimeMessageSchema.parse(JSON.parse(await messages.next()));
  assert.equal(snapshot.type, "auction.snapshot");
  checks.push({
    name: "WebSocket snapshot",
    durationMs: 0,
    detail: snapshot.auction.state,
  });

  const attempts = Array.from({ length: 24 }, (_, index) => ({
    bidderId: `integration-bidder-${index}`,
    key: `burst-${runId}-${index}`,
  }));
  const burst = await check(
    "24-way contending bid burst",
    () =>
      Promise.all(
        attempts.map(async (attempt) => ({
          ...attempt,
          ...(await bid(auctionIds.live, attempt.bidderId, attempt.key, 1_000)),
        })),
      ),
    (results) =>
      `${results.filter(({ response }) => response.status === 200).length} accepted, ${
        results.filter(({ response }) => response.status === 409).length
      } rejected`,
  );
  const accepted = burst.filter(({ response }) => response.status === 200);
  assert.equal(accepted.length, 1);
  assert.equal(burst.filter(({ response }) => response.status === 409).length, 23);
  const acceptedAttempt = accepted[0];
  assert(acceptedAttempt);

  const bidEvent = realtimeMessageSchema.parse(JSON.parse(await messages.next()));
  assert.equal(bidEvent.type, "auction.event");
  if (bidEvent.type === "auction.event") assert.equal(bidEvent.event.type, "bid.accepted");
  checks.push({
    name: "WebSocket bid fanout",
    durationMs: 0,
    detail: "bid.accepted",
  });

  await check(
    "bid idempotency replay",
    async () => {
      const replay = await bid(
        auctionIds.live,
        acceptedAttempt.bidderId,
        acceptedAttempt.key,
        1_000,
      );
      assert.equal(replay.response.status, 200);
      assert.equal(replay.result.ok && replay.result.replayed, true);
      return replay.result;
    },
    (result) => (result.ok ? `replayed sequence ${result.event.sequence}` : result.error.code),
  );

  await check(
    "idempotency-key conflict",
    async () => {
      const reused = await bid(
        auctionIds.live,
        acceptedAttempt.bidderId,
        acceptedAttempt.key,
        1_100,
      );
      assert.equal(reused.response.status, 409);
      assert.equal(reused.result.ok, false);
      if (!reused.result.ok) assert.equal(reused.result.error.code, "IDEMPOTENCY_KEY_REUSED");
      return reused.result;
    },
    (result) => (result.ok ? "unexpected success" : result.error.code),
  );

  await check(
    "minimum-bid enforcement",
    async () => {
      const low = await bid(auctionIds.live, "integration-low-bidder", `low-${runId}`, 1_050);
      assert.equal(low.response.status, 409);
      assert.equal(low.result.ok, false);
      if (!low.result.ok) assert.equal(low.result.error.code, "BID_TOO_LOW");
      return low.result;
    },
    (result) => (result.ok ? "unexpected success" : result.error.code),
  );

  const nextEventMessage = messages.next();
  await check(
    "next valid bid",
    async () => {
      const acceptedBid = await bid(
        auctionIds.live,
        "integration-next-bidder",
        `next-${runId}`,
        1_100,
      );
      assert.equal(acceptedBid.response.status, 200);
      assert.equal(acceptedBid.result.ok, true);
      return acceptedBid.result;
    },
    (result) => `${result.auction.currentPriceCents} cents`,
  );
  const nextEvent = realtimeMessageSchema.parse(JSON.parse(await nextEventMessage));
  assert.equal(nextEvent.type, "auction.event");

  await check(
    "exact historical idempotency replay",
    async () => {
      const replay = await bid(
        auctionIds.live,
        acceptedAttempt.bidderId,
        acceptedAttempt.key,
        1_000,
      );
      assert.equal(replay.response.status, 200);
      assert.equal(replay.result.ok, true);
      if (replay.result.ok) {
        assert.equal(replay.result.replayed, true);
        assert.equal(replay.result.auction.currentPriceCents, 1_000);
        assert.equal(replay.result.auction.bidCount, 1);
        assert.equal(replay.result.event.sequence, 3);
      }
      return replay.result;
    },
    (result) =>
      `original sequence ${result.event.sequence}, price ${result.auction.currentPriceCents}`,
  );

  await check(
    "WebSocket ping/pong",
    async () => {
      const pong = messages.next();
      socket.send("ping");
      return pong;
    },
    (pong) => {
      assert.equal(pong, "pong");
      return pong;
    },
  );

  const history = await check(
    "ordered history",
    async () => {
      const response = await api(
        `/v1/auctions/${auctionIds.live}/history?afterSequence=0&limit=50`,
      );
      const result = await parseResponse(response, historyResultSchema, 200);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.deepEqual(
          result.events.map((event) => event.sequence),
          [1, 2, 3, 4],
        );
      }
      return result;
    },
    (result) => result.events.map((event) => event.type).join(" → "),
  );

  await check(
    "authorization",
    async () => {
      const response = await api(`/v1/auctions/${auctionIds.live}/close`, {
        method: "POST",
        headers: await bidderHeaders("wrong-role", `wrong-role-${runId}`),
      });
      return parseResponse(response, operationFailureSchema, 403);
    },
    (failure) => failure.error.code,
  );

  await check(
    "body-size limit",
    async () => {
      const response = await api(`/v1/auctions/oversized-${runId}`, {
        method: "PUT",
        headers: await sellerHeaders(),
        body: JSON.stringify({ title: "x".repeat(17_000) }),
      });
      return parseResponse(response, operationFailureSchema, 413);
    },
    (failure) => failure.error.code,
  );

  await createAuction(auctionIds.cancelled, auctionBody("Cancellation integration auction"));
  await startAuction(auctionIds.cancelled, `cancel-start-${runId}`);
  await check(
    "cancellation",
    async () => {
      const response = await api(`/v1/auctions/${auctionIds.cancelled}/cancel`, {
        method: "POST",
        headers: await sellerHeaders(`cancel-${runId}`),
      });
      const result = await parseResponse(response, commandResultSchema, 200);
      assert.equal(result.ok && result.auction.state, "CANCELLED");
      const late = await bid(auctionIds.cancelled, "cancel-late", `cancel-late-${runId}`, 1_000);
      assert.equal(late.response.status, 409);
      return result;
    },
    (result) => (result.ok ? result.auction.state : result.error.code),
  );

  await createAuction(auctionIds.alarm, auctionBody("Alarm integration auction", 2, 10, 2));
  const alarmStarted = await startAuction(auctionIds.alarm, `alarm-start-${runId}`);
  assert.equal(alarmStarted.ok, true);
  const beforeEndsAt = alarmStarted.ok ? alarmStarted.auction.endsAt : null;
  const alarmBid = await bid(auctionIds.alarm, "alarm-winner", `alarm-bid-${runId}`, 1_000);
  assert.equal(alarmBid.response.status, 200);
  assert.equal(alarmBid.result.ok, true);
  if (alarmBid.result.ok && beforeEndsAt !== null) {
    assert.equal(alarmBid.result.auction.endsAt, beforeEndsAt + 2_000);
  }
  const closed = await check(
    "anti-sniping extension and alarm close",
    () => pollUntilClosed(auctionIds.alarm),
    (result) => `${result.auction.state}, winner ${result.auction.winnerId}`,
  );
  assert.equal(closed.ok && closed.auction.winnerId, "alarm-winner");

  await check(
    "auction isolation",
    async () =>
      parseResponse(await api(`/v1/auctions/${auctionIds.missing}`), operationFailureSchema, 404),
    (failure) => failure.error.code,
  );

  socket.close(1000, "integration complete");
  activeSocket = undefined;

  const timeline = history.ok
    ? history.events.map((event) => ({
        sequence: event.sequence,
        type: event.type,
        actorId: event.actorId,
        occurredAt: event.occurredAt,
        amountCents:
          event.type === "bid.accepted" || event.type === "auction.closed"
            ? event.payload.amountCents
            : null,
      }))
    : [];
  const summary = {
    ok: true as const,
    baseUrl: baseUrl.origin,
    runId,
    auctionIds,
    checks,
    timeline,
  };
  const report = await writeIntegrationReport(summary);
  console.log(JSON.stringify({ ...summary, report }, null, 2));
}

main().catch((error: unknown) => {
  activeSocket?.close(1011, "integration failed");
  console.error(
    JSON.stringify(
      {
        ok: false,
        baseUrl: baseUrl.origin,
        runId,
        auctionIds,
        checks,
        error: error instanceof Error ? error.stack : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
