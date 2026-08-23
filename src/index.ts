import { OpenAPIHono } from "@hono/zod-openapi";
import { zValidator } from "@hono/zod-validator";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { authenticate, AuthenticationError, websocketProtocols } from "./auth";
import {
  createDemoBidderSession,
  createDemoSession,
  DemoSessionConfigurationError,
} from "./demo-session";
import {
  auctionParamsSchema,
  bidInputSchema,
  commandHeadersSchema,
  createAuctionInputSchema,
  historyQuerySchema,
  operationFailureSchema,
  realtimeQuerySchema,
  type Actor,
  type OperationFailure,
} from "./model";
import { buildOpenApiDocument, registerOpenApi } from "./openapi";

export { Auction } from "./auction";
export { AuctionFanout } from "./fanout";

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type AppEnvironment = {
  Bindings: Env & {
    DEMO_AUTH_PRIVATE_JWK?: string;
  };
  Variables: {
    actor: Actor;
    requestId: string;
    startedAt: number;
  };
};

const requestIdSchema = z.uuid();
const jsonContentHeadersSchema = z.object({
  "content-type": z.string().regex(/^application\/json(?:\s*;.*)?$/i),
});
const bidCommandHeadersSchema = commandHeadersSchema.extend({
  "content-type": z.string().regex(/^application\/json(?:\s*;.*)?$/i),
});
const websocketHeadersSchema = z
  .object({
    upgrade: z.string().trim().toLowerCase().pipe(z.literal("websocket")),
    "sec-websocket-protocol": z.string(),
  })
  .superRefine((headers, context) => {
    const protocols = headers["sec-websocket-protocol"]
      .split(",")
      .map((protocol) => protocol.trim());
    if (!protocols.includes("auction.v1")) {
      context.addIssue({
        code: "custom",
        path: ["sec-websocket-protocol"],
        message: "must include auction.v1",
      });
    }
    if (!protocols.some((protocol) => protocol.startsWith("auth."))) {
      context.addIssue({
        code: "custom",
        path: ["sec-websocket-protocol"],
        message: "must include auth.<JWT>",
      });
    }
  });

const auctionParams = zValidator("param", auctionParamsSchema, (result) => {
  if (!result.success) {
    throw new HttpError(400, "INVALID_AUCTION_ID", formatValidationError(result.error));
  }
});

const historyQuery = zValidator("query", historyQuerySchema, (result) => {
  if (!result.success) {
    throw new HttpError(400, "INVALID_QUERY", formatValidationError(result.error));
  }
});

const realtimeQuery = zValidator("query", realtimeQuerySchema, (result) => {
  if (!result.success) {
    throw new HttpError(400, "INVALID_QUERY", formatValidationError(result.error));
  }
});

const jsonContentHeaders = zValidator("header", jsonContentHeadersSchema, (result) => {
  if (!result.success) {
    throw new HttpError(400, "INVALID_CONTENT_TYPE", formatValidationError(result.error));
  }
});

const createAuctionBody = zValidator("json", createAuctionInputSchema, (result) => {
  if (!result.success) {
    throw new HttpError(400, "INVALID_BODY", formatValidationError(result.error));
  }
});

const bidBody = zValidator("json", bidInputSchema, (result) => {
  if (!result.success) {
    throw new HttpError(400, "INVALID_BODY", formatValidationError(result.error));
  }
});

const sellerCommandHeaders = zValidator("header", commandHeadersSchema, (result) => {
  if (!result.success) {
    throw new HttpError(400, "INVALID_COMMAND_HEADERS", formatValidationError(result.error));
  }
});

const bidderCommandHeaders = zValidator("header", bidCommandHeadersSchema, (result) => {
  if (!result.success) {
    throw new HttpError(400, "INVALID_COMMAND_HEADERS", formatValidationError(result.error));
  }
});

const websocketHeaders = zValidator("header", websocketHeadersSchema, (result) => {
  if (!result.success) {
    throw new HttpError(426, "UPGRADE_REQUIRED", formatValidationError(result.error));
  }
});

const authenticatedActor = createMiddleware<AppEnvironment>(async (context, next) => {
  try {
    context.set("actor", await authenticate(context.req.raw, context.env));
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw new HttpError(
        error.code === "AUTH_CONFIGURATION_ERROR" ? 503 : 401,
        error.code,
        error.message,
      );
    }
    throw error;
  }
  await next();
});

const sellerActor = createMiddleware<AppEnvironment>(async (context, next) => {
  if (context.get("actor").role !== "seller") {
    throw new HttpError(403, "FORBIDDEN", "This operation requires the seller role");
  }
  await next();
});

const bidderActor = createMiddleware<AppEnvironment>(async (context, next) => {
  if (context.get("actor").role !== "bidder") {
    throw new HttpError(403, "FORBIDDEN", "This operation requires the bidder role");
  }
  await next();
});

const auctionRateLimit = createMiddleware<AppEnvironment>(async (context, next) => {
  const actor = context.get("actor");
  const limiter =
    context.req.method === "GET" ? context.env.READ_RATE_LIMITER : context.env.COMMAND_RATE_LIMITER;
  const { success } = await limiter.limit({
    key: [actor.id, context.req.method, context.req.path].join(":"),
  });
  if (!success) {
    throw new HttpError(429, "RATE_LIMITED", "Too many requests; retry after the rate window");
  }
  await next();
});

const auctionScope = createMiddleware<AppEnvironment>(async (context, next) => {
  const scopedAuctionId = context.get("actor").auctionId;
  if (scopedAuctionId && scopedAuctionId !== context.req.param("auctionId")) {
    throw new HttpError(403, "AUCTION_SCOPE_MISMATCH", "This token belongs to a different auction");
  }
  await next();
});

const app = new OpenAPIHono<AppEnvironment>({ strict: false });
registerOpenApi(app);

app.use("*", async (context, next) => {
  const suppliedRequestId = requestIdSchema.safeParse(context.req.header("X-Request-Id"));
  const requestId = suppliedRequestId.success ? suppliedRequestId.data : crypto.randomUUID();
  const startedAt = performance.now();
  context.set("requestId", requestId);
  context.set("startedAt", startedAt);
  await next();
  context.header("X-Request-Id", requestId);
  console.log(
    JSON.stringify({
      level: "info",
      message: "Request completed",
      requestId,
      cfRay: context.req.header("CF-Ray") ?? null,
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    }),
  );
});

app.use(
  "/v1/*",
  cors({
    origin: (origin, context) =>
      context.env.WEB_ORIGINS.split(",")
        .map((candidate: string) => candidate.trim())
        .includes(origin)
        ? origin
        : null,
    allowMethods: ["GET", "PUT", "POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id"],
    exposeHeaders: ["X-Request-Id"],
    maxAge: 86_400,
  }),
);

app.use(
  "/v1/auctions/*",
  bodyLimit({
    maxSize: 16_384,
    onError: () => jsonFailure(413, "BODY_TOO_LARGE", "Request body cannot exceed 16384 bytes"),
  }),
);
app.use("/v1/auctions/*", authenticatedActor);
app.use("/v1/auctions/:auctionId", auctionScope);
app.use("/v1/auctions/:auctionId/*", auctionScope);
app.use("/v1/auctions/*", auctionRateLimit);

app.get("/health", (context) =>
  context.json({
    ok: true,
    service: "cloudflare-live-auction",
    environment: context.env.ENVIRONMENT,
  }),
);
app.get("/openapi.json", (context) => context.json(buildOpenApiDocument()));

app.post("/v1/demo-session", async (context) => {
  if (context.env.DEMO_MODE !== "enabled") {
    return jsonFailure(404, "ROUTE_NOT_FOUND", "Route not found");
  }

  const clientAddress = context.req.header("CF-Connecting-IP") ?? "local";
  const { success } = await context.env.COMMAND_RATE_LIMITER.limit({
    key: `demo-session:${clientAddress}`,
  });
  if (!success) {
    return jsonFailure(429, "RATE_LIMITED", "Too many demo sessions; retry after the rate window");
  }

  try {
    return json(await createDemoSession(context.env), 201);
  } catch (error) {
    if (error instanceof DemoSessionConfigurationError) {
      throw new HttpError(503, "DEMO_CONFIGURATION_ERROR", error.message);
    }
    throw error;
  }
});

app.post("/v1/demo-session/:auctionId/bidder", auctionParams, async (context) => {
  if (context.env.DEMO_MODE !== "enabled") {
    return jsonFailure(404, "ROUTE_NOT_FOUND", "Route not found");
  }

  const { auctionId } = context.req.valid("param");
  if (!auctionId.startsWith("demo-")) {
    return jsonFailure(404, "DEMO_AUCTION_NOT_FOUND", "Demo auction not found");
  }

  const clientAddress = context.req.header("CF-Connecting-IP") ?? "local";
  const { success } = await context.env.COMMAND_RATE_LIMITER.limit({
    key: `demo-bidder:${clientAddress}:${auctionId}`,
  });
  if (!success) {
    return jsonFailure(429, "RATE_LIMITED", "Too many demo bidders; retry after the rate window");
  }

  const auction = await context.env.AUCTIONS.getByName(auctionId).getAuction();
  const expectedSellerId = `demo-seller-${auctionId.slice("demo-".length)}`;
  if (!auction.ok || auction.auction.sellerId !== expectedSellerId) {
    return jsonFailure(404, "DEMO_AUCTION_NOT_FOUND", "Demo auction not found");
  }
  if (auction.auction.state !== "LIVE") {
    return jsonFailure(409, "DEMO_AUCTION_NOT_LIVE", "This demo auction is not live");
  }

  try {
    return json(await createDemoBidderSession(context.env, auctionId), 201);
  } catch (error) {
    if (error instanceof DemoSessionConfigurationError) {
      throw new HttpError(503, "DEMO_CONFIGURATION_ERROR", error.message);
    }
    throw error;
  }
});

app.put(
  "/v1/auctions/:auctionId",
  auctionParams,
  sellerActor,
  jsonContentHeaders,
  createAuctionBody,
  async (context) => {
    const { auctionId } = context.req.valid("param");
    const input = context.req.valid("json");
    const result = await context.env.AUCTIONS.getByName(auctionId).createAuction(
      auctionId,
      context.get("actor").id,
      input,
    );
    return json(result, result.ok ? (result.replayed ? 200 : 201) : result.error.status);
  },
);

app.get("/v1/auctions/:auctionId", auctionParams, async (context) => {
  const { auctionId } = context.req.valid("param");
  const result = await context.env.AUCTIONS.getByName(auctionId).getAuction();
  return json(result, result.ok ? 200 : result.error.status);
});

app.get("/v1/auctions/:auctionId/history", auctionParams, historyQuery, async (context) => {
  const { auctionId } = context.req.valid("param");
  const query = context.req.valid("query");
  const result = await context.env.AUCTIONS.getByName(auctionId).getHistory(
    query.afterSequence,
    query.limit,
  );
  return json(result, result.ok ? 200 : result.error.status);
});

app.post(
  "/v1/auctions/:auctionId/start",
  auctionParams,
  sellerActor,
  sellerCommandHeaders,
  async (context) => {
    const { auctionId } = context.req.valid("param");
    const headers = context.req.valid("header");
    const result = await context.env.AUCTIONS.getByName(auctionId).startAuction(
      context.get("actor").id,
      headers["idempotency-key"],
    );
    return json(result, result.ok ? 200 : result.error.status);
  },
);

app.post(
  "/v1/auctions/:auctionId/bids",
  auctionParams,
  bidderActor,
  bidderCommandHeaders,
  bidBody,
  async (context) => {
    const { auctionId } = context.req.valid("param");
    const headers = context.req.valid("header");
    const { amountCents } = context.req.valid("json");
    const result = await context.env.AUCTIONS.getByName(auctionId).placeBid(
      context.get("actor").id,
      headers["idempotency-key"],
      amountCents,
    );
    return json(result, result.ok ? 200 : result.error.status);
  },
);

app.post(
  "/v1/auctions/:auctionId/close",
  auctionParams,
  sellerActor,
  sellerCommandHeaders,
  async (context) => {
    const { auctionId } = context.req.valid("param");
    const headers = context.req.valid("header");
    const result = await context.env.AUCTIONS.getByName(auctionId).closeAuction(
      context.get("actor").id,
      headers["idempotency-key"],
    );
    return json(result, result.ok ? 200 : result.error.status);
  },
);

app.post(
  "/v1/auctions/:auctionId/cancel",
  auctionParams,
  sellerActor,
  sellerCommandHeaders,
  async (context) => {
    const { auctionId } = context.req.valid("param");
    const headers = context.req.valid("header");
    const result = await context.env.AUCTIONS.getByName(auctionId).cancelAuction(
      context.get("actor").id,
      headers["idempotency-key"],
    );
    return json(result, result.ok ? 200 : result.error.status);
  },
);

app.get(
  "/v1/auctions/:auctionId/events",
  auctionParams,
  realtimeQuery,
  websocketHeaders,
  (context) => {
    const { auctionId } = context.req.valid("param");
    const protocols = websocketProtocols(context.req.raw);
    if (!protocols.includes("auction.v1")) {
      throw new HttpError(426, "UPGRADE_REQUIRED", "Use the auction.v1 WebSocket protocol");
    }
    const shard = fanoutShard(context.get("actor").id);
    const headers = new Headers(context.req.raw.headers);
    headers.delete("Authorization");
    headers.set("Sec-WebSocket-Protocol", "auction.v1");
    headers.set("X-Auction-Id", auctionId);
    return context.env.AUCTION_FANOUT.getByName(`${auctionId}:${shard}`).fetch(
      new Request(context.req.raw, { headers }),
    );
  },
);

app.notFound(() => jsonFailure(404, "ROUTE_NOT_FOUND", "Route not found"));

app.onError((error, context) => {
  const requestId = context.get("requestId") || crypto.randomUUID();
  if (error instanceof HttpError) {
    return jsonFailure(error.status, error.code, error.message, requestId);
  }
  if (error instanceof HTTPException) {
    const isJsonError = error.status === 400 && error.message.toLowerCase().includes("json");
    return jsonFailure(
      error.status,
      isJsonError ? "INVALID_JSON" : "HTTP_ERROR",
      error.message,
      requestId,
    );
  }

  const normalized = error instanceof Error ? error : new Error(String(error));
  console.error(
    JSON.stringify({
      level: "error",
      message: "Unhandled request error",
      requestId,
      cfRay: context.req.header("CF-Ray") ?? null,
      method: context.req.method,
      path: context.req.path,
      durationMs: Math.round((performance.now() - context.get("startedAt")) * 10) / 10,
      errorName: normalized.name,
      error: normalized.message,
      stack: normalized.stack ?? null,
      cause:
        normalized.cause instanceof Error
          ? normalized.cause.message
          : normalized.cause === undefined
            ? null
            : JSON.stringify(normalized.cause),
    }),
  );
  return jsonFailure(500, "INTERNAL_ERROR", "Internal server error", requestId);
});

function formatValidationError(error: {
  readonly issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[];
}): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "value"}: ${issue.message}`)
    .join("; ");
}

function json(value: unknown, status = 200, requestId?: string): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (requestId) headers.set("X-Request-Id", requestId);
  return Response.json(value, { status, headers });
}

function jsonFailure(status: number, code: string, message: string, requestId?: string): Response {
  const body: OperationFailure = operationFailureSchema.parse({
    ok: false,
    error: { status, code, message },
  });
  return json(body, status, requestId);
}

function fanoutShard(actorId: string): number {
  let hash = 2_166_136_261;
  for (const character of actorId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 4;
}

export default app;
