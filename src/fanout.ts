import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  auctionIdSchema,
  realtimeEventMessageSchema,
  realtimeQuerySchema,
  type RealtimeEventMessage,
} from "./model";

const MAX_CONNECTIONS_PER_SHARD = 2_000;
const RETAINED_EVENTS = 500;

const attachmentSchema = z.strictObject({
  ready: z.boolean(),
  cursor: z.int().nonnegative(),
});

const storedMessageRowSchema = z.strictObject({
  sequence: z.int().positive(),
  message_json: z.string(),
});

export class AuctionFanout extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          sequence INTEGER PRIMARY KEY,
          message_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    });
  }

  async publish(value: RealtimeEventMessage): Promise<void> {
    const message = realtimeEventMessageSchema.parse(value);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO messages (sequence, message_json, created_at) VALUES (?, ?, ?)",
      message.event.sequence,
      JSON.stringify(message),
      Date.now(),
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM messages WHERE sequence <= ?",
      message.event.sequence - RETAINED_EVENTS,
    );

    const payload = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentSchema.safeParse(socket.deserializeAttachment());
      if (!attachment.success || !attachment.data.ready) continue;
      if (message.event.sequence <= attachment.data.cursor) continue;
      try {
        socket.send(payload);
        socket.serializeAttachment({ ready: true, cursor: message.event.sequence });
      } catch {
        socket.close(1011, "Realtime delivery failed");
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS_PER_SHARD) {
      return Response.json(
        {
          ok: false,
          error: {
            status: 503,
            code: "REALTIME_SHARD_FULL",
            message: "This realtime shard is full; reconnect to be assigned again",
          },
        },
        { status: 503 },
      );
    }

    const auctionId = auctionIdSchema.parse(request.headers.get("X-Auction-Id"));
    const { afterSequence } = realtimeQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ready: false, cursor: afterSequence ?? 0 });

    const bootstrap =
      await this.env.AUCTIONS.getByName(auctionId).getRealtimeBootstrap(afterSequence);
    if (!bootstrap.ok) {
      server.close(1008, bootstrap.error.code);
      return Response.json(bootstrap, { status: bootstrap.error.status });
    }

    server.send(JSON.stringify(bootstrap.message));
    let cursor = bootstrap.message.cursor;
    for (const message of this.readMessagesAfter(cursor)) {
      server.send(JSON.stringify(message));
      cursor = message.event.sequence;
    }
    server.serializeAttachment({ ready: true, cursor });

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": "auction.v1" },
    });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === "string" && message === "ping") socket.send("pong");
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "WebSocket error");
  }

  private readMessagesAfter(sequence: number): RealtimeEventMessage[] {
    return this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT sequence, message_json FROM messages WHERE sequence > ? ORDER BY sequence ASC",
        sequence,
      )
      .toArray()
      .map((row) => {
        const stored = storedMessageRowSchema.parse(row);
        return realtimeEventMessageSchema.parse(JSON.parse(stored.message_json));
      });
  }
}
