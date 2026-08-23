import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env as HonoEnvironment } from "hono";
import type { ZodType } from "zod";
import {
  auctionParamsSchema,
  bidInputSchema,
  commandHeadersSchema,
  commandSuccessSchema,
  createAuctionInputSchema,
  demoBidderSessionSuccessSchema,
  demoSessionSuccessSchema,
  healthSchema,
  historyQuerySchema,
  historySuccessSchema,
  operationFailureSchema,
  readSuccessSchema,
  realtimeMessageSchema,
  realtimeQuerySchema,
} from "./model";

const jsonContent = (schema: ZodType) => ({
  "application/json": { schema },
});

function response(
  schema:
    | typeof commandSuccessSchema
    | typeof readSuccessSchema
    | typeof historySuccessSchema
    | typeof operationFailureSchema
    | typeof healthSchema
    | typeof demoSessionSuccessSchema
    | typeof demoBidderSessionSuccessSchema,
  description = "Response",
) {
  return { description, content: jsonContent(schema) };
}

const errorResponses = {
  400: response(operationFailureSchema, "Invalid request"),
  401: response(operationFailureSchema, "Missing or invalid access token"),
  403: response(operationFailureSchema, "Insufficient role or auction ownership"),
  404: response(operationFailureSchema, "Auction not found"),
  409: response(operationFailureSchema, "Auction state conflict"),
  413: response(operationFailureSchema, "Request body too large"),
  429: response(operationFailureSchema, "Rate limit exceeded"),
  500: response(operationFailureSchema, "Internal server error"),
  503: response(operationFailureSchema, "Temporarily unavailable"),
};

export function registerOpenApi<Environment extends HonoEnvironment>(
  app: OpenAPIHono<Environment>,
): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description:
      "JWT subject becomes actorId; the signed role claim determines seller, bidder, or viewer permissions.",
  });

  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/health",
    summary: "Worker health",
    responses: { 200: response(healthSchema, "Worker is healthy") },
  });

  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/demo-session/{auctionId}/bidder",
    summary: "Join a live demo as a new bidder",
    description:
      "Available only in demo-enabled environments. Returns a distinct 15-minute bidder token scoped to an existing live demo auction.",
    request: { params: auctionParamsSchema },
    responses: {
      201: response(demoBidderSessionSuccessSchema, "Demo bidder created"),
      404: response(operationFailureSchema, "Live demo auction not found or demos disabled"),
      409: response(operationFailureSchema, "Demo auction is not live"),
      429: response(operationFailureSchema, "Rate limit exceeded"),
      503: response(operationFailureSchema, "Demo signing is unavailable"),
    },
  });

  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/demo-session",
    summary: "Create a short-lived demo room",
    description:
      "Available only in demo-enabled environments. Returns 15-minute role tokens scoped to one generated auction ID.",
    responses: {
      201: response(demoSessionSuccessSchema, "Demo session created"),
      404: response(operationFailureSchema, "Demo sessions are disabled"),
      429: response(operationFailureSchema, "Rate limit exceeded"),
      503: response(operationFailureSchema, "Demo signing is unavailable"),
    },
  });

  app.openAPIRegistry.registerPath({
    method: "put",
    path: "/v1/auctions/{auctionId}",
    summary: "Create an auction",
    security: [{ bearerAuth: [] }],
    request: {
      params: auctionParamsSchema,
      body: {
        content: { "application/json": { schema: createAuctionInputSchema } },
      },
    },
    responses: {
      200: response(commandSuccessSchema, "Existing identical auction"),
      201: response(commandSuccessSchema, "Auction created"),
      ...errorResponses,
    },
  });

  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/auctions/{auctionId}",
    summary: "Read current auction state",
    security: [{ bearerAuth: [] }],
    request: { params: auctionParamsSchema },
    responses: {
      200: response(readSuccessSchema, "Current auction state"),
      ...errorResponses,
    },
  });

  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/auctions/{auctionId}/history",
    summary: "Read ordered auction events",
    security: [{ bearerAuth: [] }],
    request: { params: auctionParamsSchema, query: historyQuerySchema },
    responses: {
      200: response(historySuccessSchema, "Ordered event page"),
      ...errorResponses,
    },
  });

  for (const [path, summary] of [
    ["/v1/auctions/{auctionId}/start", "Start an auction"],
    ["/v1/auctions/{auctionId}/close", "Close an ended auction"],
    ["/v1/auctions/{auctionId}/cancel", "Cancel an auction"],
  ] as const) {
    app.openAPIRegistry.registerPath({
      method: "post",
      path,
      summary,
      security: [{ bearerAuth: [] }],
      request: { params: auctionParamsSchema, headers: commandHeadersSchema },
      responses: {
        200: response(commandSuccessSchema, "Command accepted or replayed"),
        ...errorResponses,
      },
    });
  }

  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/auctions/{auctionId}/bids",
    summary: "Place a bid",
    security: [{ bearerAuth: [] }],
    request: {
      params: auctionParamsSchema,
      headers: commandHeadersSchema,
      body: { content: { "application/json": { schema: bidInputSchema } } },
    },
    responses: {
      200: response(commandSuccessSchema, "Bid accepted or replayed"),
      ...errorResponses,
    },
  });

  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/auctions/{auctionId}/events",
    summary: "Connect to sharded realtime updates",
    description:
      "Use WebSocket subprotocols auction.v1 and auth.<JWT>. Reconnect with afterSequence to receive bounded catch-up events in the snapshot.",
    security: [{ bearerAuth: [] }],
    request: { params: auctionParamsSchema, query: realtimeQuerySchema },
    responses: {
      101: {
        description: "WebSocket upgraded; messages conform to RealtimeMessage",
        content: { "application/json": { schema: realtimeMessageSchema } },
      },
      ...errorResponses,
    },
  });
}

export function buildOpenApiDocument() {
  const registry = new OpenAPIHono();
  registerOpenApi(registry);
  return registry.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Cloudflare Live Auction API",
      version: "1.0.0",
      description:
        "Strongly ordered live auctions backed by one authoritative Durable Object per auction and sharded realtime fanout.",
    },
  });
}
