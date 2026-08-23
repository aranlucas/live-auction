import { z } from "@hono/zod-openapi";

export const AUCTION_STATES = ["DRAFT", "LIVE", "CLOSED", "CANCELLED"] as const;
export const ACTOR_ROLES = ["seller", "bidder", "viewer"] as const;

export const auctionStateSchema = z.enum(AUCTION_STATES).openapi("AuctionState");
export const actorRoleSchema = z.enum(ACTOR_ROLES).openapi("ActorRole");

export const auctionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,100}$/, "must contain 1-100 URL-safe characters")
  .openapi({
    param: { name: "auctionId", in: "path" },
    example: "vintage-camera-2026",
  });

export const auctionParamsSchema = z.strictObject({ auctionId: auctionIdSchema });

export const idempotencyKeySchema = z
  .string()
  .trim()
  .regex(/^[\x21-\x7E]{1,200}$/, "must contain 1-200 visible ASCII characters")
  .openapi({ example: "bid-018f4e9f" });

export const authorizationHeaderSchema = z
  .string()
  .regex(/^Bearer [^\s]+$/, "must use a Bearer token");

export const authenticatedHeadersSchema = z.object({
  authorization: authorizationHeaderSchema,
});

export const commandHeadersSchema = z.object({
  authorization: authorizationHeaderSchema,
  "idempotency-key": idempotencyKeySchema,
});

export const createAuctionInputSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    currency: z.string().regex(/^[A-Z]{3}$/, "must be a three-letter uppercase code"),
    startPriceCents: z.int().min(1),
    minIncrementCents: z.int().min(1),
    durationSeconds: z.int().min(1).max(86_400),
    antiSnipeWindowSeconds: z.int().min(0).max(300),
    extensionSeconds: z.int().min(0).max(300),
  })
  .superRefine((input, context) => {
    if ((input.antiSnipeWindowSeconds === 0) !== (input.extensionSeconds === 0)) {
      context.addIssue({
        code: "custom",
        path: ["extensionSeconds"],
        message:
          "antiSnipeWindowSeconds and extensionSeconds must both be zero or both be positive",
      });
    }
  })
  .openapi("CreateAuctionInput");

export const bidInputSchema = z.strictObject({ amountCents: z.int().min(1) }).openapi("BidInput");

export const historyQuerySchema = z.strictObject({
  afterSequence: z.coerce.number().pipe(z.int().min(0)).default(0),
  limit: z.coerce.number().pipe(z.int().min(1).max(100)).default(50),
});

export const realtimeQuerySchema = z.strictObject({
  afterSequence: z.coerce.number().pipe(z.int().min(0)).optional(),
});

export const auctionViewSchema = z
  .strictObject({
    id: z.string(),
    sellerId: z.string(),
    title: z.string(),
    currency: z.string(),
    state: auctionStateSchema,
    startPriceCents: z.int().positive(),
    currentPriceCents: z.int().positive().nullable(),
    nextMinimumBidCents: z.int().positive(),
    minIncrementCents: z.int().positive(),
    leaderId: z.string().nullable(),
    bidCount: z.int().nonnegative(),
    version: z.int().positive(),
    durationSeconds: z.int().positive(),
    antiSnipeWindowSeconds: z.int().nonnegative(),
    extensionSeconds: z.int().nonnegative(),
    startsAt: z.int().nonnegative().nullable(),
    endsAt: z.int().nonnegative().nullable(),
    closedAt: z.int().nonnegative().nullable(),
    winnerId: z.string().nullable(),
  })
  .openapi("Auction");

export const eventPayloadSchemas = {
  "auction.created": z.strictObject({
    title: z.string(),
    currency: z.string(),
    startPriceCents: z.int().positive(),
  }),
  "auction.started": z.strictObject({ endsAt: z.int().nonnegative() }),
  "bid.accepted": z.strictObject({
    bidId: z.string(),
    amountCents: z.int().positive(),
    extended: z.boolean(),
    endsAt: z.int().nonnegative(),
  }),
  "auction.cancelled": z.strictObject({}),
  "auction.closed": z.strictObject({
    winnerId: z.string().nullable(),
    amountCents: z.int().positive().nullable(),
  }),
} as const;

const eventBaseShape = {
  sequence: z.int().positive(),
  actorId: z.string(),
  occurredAt: z.int().nonnegative(),
};

export const auctionEventSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      ...eventBaseShape,
      type: z.literal("auction.created"),
      payload: eventPayloadSchemas["auction.created"],
    }),
    z.strictObject({
      ...eventBaseShape,
      type: z.literal("auction.started"),
      payload: eventPayloadSchemas["auction.started"],
    }),
    z.strictObject({
      ...eventBaseShape,
      type: z.literal("bid.accepted"),
      payload: eventPayloadSchemas["bid.accepted"],
    }),
    z.strictObject({
      ...eventBaseShape,
      type: z.literal("auction.cancelled"),
      payload: eventPayloadSchemas["auction.cancelled"],
    }),
    z.strictObject({
      ...eventBaseShape,
      type: z.literal("auction.closed"),
      payload: eventPayloadSchemas["auction.closed"],
    }),
  ])
  .openapi("AuctionEvent");

export const eventPayloadSchema = z.union([
  eventPayloadSchemas["auction.created"],
  eventPayloadSchemas["auction.started"],
  eventPayloadSchemas["bid.accepted"],
  eventPayloadSchemas["auction.cancelled"],
  eventPayloadSchemas["auction.closed"],
]);

export const operationFailureSchema = z
  .strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.string(),
      message: z.string(),
      status: z.int().min(400).max(599),
    }),
  })
  .openapi("Error");

export const commandSuccessSchema = z
  .strictObject({
    ok: z.literal(true),
    auction: auctionViewSchema,
    event: auctionEventSchema,
    replayed: z.boolean(),
  })
  .openapi("CommandSuccess");

export const readSuccessSchema = z
  .strictObject({ ok: z.literal(true), auction: auctionViewSchema })
  .openapi("ReadSuccess");

export const historySuccessSchema = z
  .strictObject({
    ok: z.literal(true),
    auction: auctionViewSchema,
    events: z.array(auctionEventSchema),
  })
  .openapi("HistorySuccess");

export const commandResultSchema = z.discriminatedUnion("ok", [
  commandSuccessSchema,
  operationFailureSchema,
]);

export const readResultSchema = z.discriminatedUnion("ok", [
  readSuccessSchema,
  operationFailureSchema,
]);

export const historyResultSchema = z.discriminatedUnion("ok", [
  historySuccessSchema,
  operationFailureSchema,
]);

export const realtimeSnapshotMessageSchema = z.strictObject({
  type: z.literal("auction.snapshot"),
  auction: auctionViewSchema,
  events: z.array(auctionEventSchema),
  cursor: z.int().positive(),
  resyncRequired: z.boolean(),
});

export const realtimeEventMessageSchema = z.strictObject({
  type: z.literal("auction.event"),
  auction: auctionViewSchema,
  event: auctionEventSchema,
  cursor: z.int().positive(),
});

export const realtimeMessageSchema = z
  .discriminatedUnion("type", [realtimeSnapshotMessageSchema, realtimeEventMessageSchema])
  .openapi("RealtimeMessage");

export const realtimeBootstrapSuccessSchema = z.strictObject({
  ok: z.literal(true),
  message: realtimeSnapshotMessageSchema,
});

export const realtimeBootstrapResultSchema = z.discriminatedUnion("ok", [
  realtimeBootstrapSuccessSchema,
  operationFailureSchema,
]);

export const actorSchema = z.strictObject({
  id: z.string().min(1).max(200),
  role: actorRoleSchema,
  auctionId: auctionIdSchema.optional(),
});

export const demoSessionSuccessSchema = z
  .strictObject({
    ok: z.literal(true),
    auctionId: auctionIdSchema,
    expiresAt: z.int().positive(),
    sellerToken: z.string().min(1),
    bidderToken: z.string().min(1),
    viewerToken: z.string().min(1),
  })
  .openapi("DemoSessionSuccess");

export const demoSessionResultSchema = z.discriminatedUnion("ok", [
  demoSessionSuccessSchema,
  operationFailureSchema,
]);

export const healthSchema = z
  .strictObject({ ok: z.literal(true), service: z.string(), environment: z.string() })
  .openapi("Health");

export type AuctionState = z.infer<typeof auctionStateSchema>;
export type ActorRole = z.infer<typeof actorRoleSchema>;
export type Actor = z.infer<typeof actorSchema>;
export type CreateAuctionInput = z.infer<typeof createAuctionInputSchema>;
export type AuctionView = z.infer<typeof auctionViewSchema>;
export type AuctionEvent = z.infer<typeof auctionEventSchema>;
export type AuctionEventType = AuctionEvent["type"];
export type EventPayloadByType = {
  [Type in AuctionEventType]: z.infer<(typeof eventPayloadSchemas)[Type]>;
};
export type CommandSuccess = z.infer<typeof commandSuccessSchema>;
export type ReadSuccess = z.infer<typeof readSuccessSchema>;
export type HistorySuccess = z.infer<typeof historySuccessSchema>;
export type OperationFailure = z.infer<typeof operationFailureSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
export type ReadResult = z.infer<typeof readResultSchema>;
export type HistoryResult = z.infer<typeof historyResultSchema>;
export type RealtimeMessage = z.infer<typeof realtimeMessageSchema>;
export type RealtimeEventMessage = z.infer<typeof realtimeEventMessageSchema>;
export type RealtimeBootstrapResult = z.infer<typeof realtimeBootstrapResultSchema>;
export type DemoSessionSuccess = z.infer<typeof demoSessionSuccessSchema>;
export type DemoSessionResult = z.infer<typeof demoSessionResultSchema>;
