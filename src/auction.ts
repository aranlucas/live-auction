import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  auctionEventSchema,
  auctionViewSchema,
  auctionActionSuccessSchema,
  eventPayloadSchemas,
  realtimeEventMessageSchema,
  type AuctionEvent,
  type AuctionEventType,
  type AuctionState,
  type AuctionView,
  type AuctionActionResult,
  type AuctionActionSuccess,
  type CreateAuctionInput,
  type EventPayloadByType,
  type HistoryResult,
  type OperationFailure,
  type ReadResult,
  type RealtimeBootstrapResult,
  type RealtimeEventMessage,
} from "./model";

const FANOUT_SHARD_COUNT = 4;
const REALTIME_CATCHUP_LIMIT = 200;
const sqlRowSchema = z.record(z.string(), z.unknown());

const auctionRowSchema = z.strictObject({
  id: z.string(),
  seller_id: z.string(),
  title: z.string(),
  currency: z.string(),
  state: z.enum(["DRAFT", "LIVE", "CLOSED", "CANCELLED"]),
  start_price_cents: z.int().positive(),
  current_price_cents: z.int().positive().nullable(),
  min_increment_cents: z.int().positive(),
  leader_id: z.string().nullable(),
  bid_count: z.int().nonnegative(),
  version: z.int().positive(),
  duration_seconds: z.int().positive(),
  anti_snipe_window_seconds: z.int().nonnegative(),
  extension_seconds: z.int().nonnegative(),
  starts_at: z.int().nonnegative().nullable(),
  ends_at: z.int().nonnegative().nullable(),
  closed_at: z.int().nonnegative().nullable(),
  winner_id: z.string().nullable(),
});

const eventRowSchema = z.strictObject({
  sequence: z.int().positive(),
  type: z.string(),
  actor_id: z.string(),
  occurred_at: z.int().nonnegative(),
  payload_json: z.string(),
});

const idempotencyRecordSchema = z.strictObject({
  action_type: z.string(),
  request_fingerprint: z.string(),
  event_sequence: z.int().positive(),
  response_json: z.string(),
});

type AuctionRow = z.infer<typeof auctionRowSchema>;
type EventRow = z.infer<typeof eventRowSchema>;
type IdempotencyRecord = z.infer<typeof idempotencyRecordSchema>;

interface AuctionActionOutcome {
  result: AuctionActionResult;
  published?: AuctionActionSuccess;
}

const failure = (status: number, code: string, message: string): OperationFailure => ({
  ok: false,
  error: { status, code, message },
});

export class Auction extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    const currentVersion = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations",
      )
      .one().version;

    if (currentVersion < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE auction (
          id TEXT PRIMARY KEY,
          seller_id TEXT NOT NULL,
          title TEXT NOT NULL,
          currency TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('DRAFT', 'LIVE', 'CLOSED', 'CANCELLED')),
          start_price_cents INTEGER NOT NULL,
          current_price_cents INTEGER,
          min_increment_cents INTEGER NOT NULL,
          leader_id TEXT,
          bid_count INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL,
          duration_seconds INTEGER NOT NULL,
          anti_snipe_window_seconds INTEGER NOT NULL,
          extension_seconds INTEGER NOT NULL,
          starts_at INTEGER,
          ends_at INTEGER,
          closed_at INTEGER,
          winner_id TEXT
        );
        CREATE TABLE bids (
          id TEXT PRIMARY KEY,
          bidder_id TEXT NOT NULL,
          amount_cents INTEGER NOT NULL,
          sequence INTEGER NOT NULL UNIQUE,
          accepted_at INTEGER NOT NULL
        );
        CREATE INDEX bids_by_sequence ON bids(sequence);
        CREATE TABLE events (
          sequence INTEGER PRIMARY KEY,
          type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE idempotency_records (
          actor_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          action_type TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          event_sequence INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (actor_id, idempotency_key)
        );
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (1, ${Date.now()});
      `);
    }

    if (currentVersion < 2) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE idempotency_records ADD COLUMN response_json TEXT;
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (2, ${Date.now()});
      `);
    }

    if (currentVersion < 3) {
      this.ctx.storage.sql.exec(`
        CREATE TRIGGER validate_auction_insert
        BEFORE INSERT ON auction
        WHEN NEW.start_price_cents <= 0
          OR NEW.min_increment_cents <= 0
          OR NEW.duration_seconds <= 0
          OR NEW.duration_seconds > 86400
          OR NEW.anti_snipe_window_seconds < 0
          OR NEW.extension_seconds < 0
          OR ((NEW.anti_snipe_window_seconds = 0) != (NEW.extension_seconds = 0))
          OR NEW.bid_count < 0
          OR NEW.version <= 0
          OR NEW.currency NOT GLOB '[A-Z][A-Z][A-Z]'
        BEGIN SELECT RAISE(ABORT, 'auction invariant violated'); END;

        CREATE TRIGGER validate_auction_update
        BEFORE UPDATE ON auction
        WHEN NEW.start_price_cents <= 0
          OR NEW.min_increment_cents <= 0
          OR NEW.duration_seconds <= 0
          OR NEW.duration_seconds > 86400
          OR NEW.anti_snipe_window_seconds < 0
          OR NEW.extension_seconds < 0
          OR ((NEW.anti_snipe_window_seconds = 0) != (NEW.extension_seconds = 0))
          OR NEW.bid_count < 0
          OR NEW.version <= 0
          OR (NEW.state = 'DRAFT' AND (NEW.starts_at IS NOT NULL OR NEW.ends_at IS NOT NULL))
          OR (NEW.state = 'LIVE' AND (NEW.starts_at IS NULL OR NEW.ends_at IS NULL))
          OR (NEW.state = 'CLOSED' AND (NEW.starts_at IS NULL OR NEW.ends_at IS NULL OR NEW.closed_at IS NULL))
          OR (NEW.bid_count = 0 AND (NEW.current_price_cents IS NOT NULL OR NEW.leader_id IS NOT NULL))
          OR (NEW.bid_count > 0 AND (NEW.current_price_cents IS NULL OR NEW.leader_id IS NULL))
          OR (NEW.current_price_cents IS NOT NULL AND NEW.current_price_cents <= 0)
          OR (NEW.winner_id IS NOT NULL AND NEW.state != 'CLOSED')
        BEGIN SELECT RAISE(ABORT, 'auction invariant violated'); END;

        CREATE TRIGGER validate_bid_insert
        BEFORE INSERT ON bids
        WHEN NEW.amount_cents <= 0 OR NEW.sequence <= 0
        BEGIN SELECT RAISE(ABORT, 'bid invariant violated'); END;

        CREATE TRIGGER validate_event_insert
        BEFORE INSERT ON events
        WHEN NEW.sequence <= 0
          OR NEW.type NOT IN (
            'auction.created', 'auction.started', 'bid.accepted',
            'auction.cancelled', 'auction.closed'
          )
        BEGIN SELECT RAISE(ABORT, 'event invariant violated'); END;

        CREATE TRIGGER validate_idempotency_record_insert
        BEFORE INSERT ON idempotency_records
        WHEN NEW.event_sequence <= 0 OR NEW.response_json IS NULL
        BEGIN SELECT RAISE(ABORT, 'idempotency record invariant violated'); END;

        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (3, ${Date.now()});
      `);
    }

    if (currentVersion < 4) {
      this.ctx.storage.sql.exec(`
        DROP TRIGGER IF EXISTS validate_command_insert;
        DROP TABLE IF EXISTS command_results;
        CREATE TABLE IF NOT EXISTS idempotency_records (
          actor_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          action_type TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          event_sequence INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          response_json TEXT NOT NULL,
          PRIMARY KEY (actor_id, idempotency_key)
        );
        CREATE TRIGGER IF NOT EXISTS validate_idempotency_record_insert
        BEFORE INSERT ON idempotency_records
        WHEN NEW.event_sequence <= 0 OR NEW.response_json IS NULL
        BEGIN SELECT RAISE(ABORT, 'idempotency record invariant violated'); END;
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (4, ${Date.now()});
      `);
    }
  }

  async createAuction(
    auctionId: string,
    sellerId: string,
    input: CreateAuctionInput,
  ): Promise<AuctionActionResult> {
    const existing = this.readAuctionRow();
    if (existing) {
      if (this.matchesCreate(existing, auctionId, sellerId, input)) {
        const event = this.readEvent(1);
        return event
          ? auctionActionSuccessSchema.parse({
              ok: true,
              auction: this.toView(existing),
              event,
              replayed: true,
            })
          : failure(500, "INVARIANT_VIOLATION", "The creation event is missing");
      }
      return failure(
        409,
        "AUCTION_ALREADY_EXISTS",
        "That auction ID already exists with different settings",
      );
    }

    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO auction (
          id, seller_id, title, currency, state, start_price_cents,
          min_increment_cents, version, duration_seconds,
          anti_snipe_window_seconds, extension_seconds
        ) VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, 1, ?, ?, ?)`,
        auctionId,
        sellerId,
        input.title,
        input.currency,
        input.startPriceCents,
        input.minIncrementCents,
        input.durationSeconds,
        input.antiSnipeWindowSeconds,
        input.extensionSeconds,
      );
      const event = this.insertEvent(1, "auction.created", sellerId, now, {
        title: input.title,
        currency: input.currency,
        startPriceCents: input.startPriceCents,
      });
      return auctionActionSuccessSchema.parse({
        ok: true,
        auction: this.toView(this.requireAuctionRow()),
        event,
        replayed: false,
      });
    });

    this.publish(result);
    return result;
  }

  async getAuction(): Promise<ReadResult> {
    const closed = await this.closeIfDue(Date.now());
    if (closed) this.publish(closed);
    const row = this.readAuctionRow();
    return row
      ? { ok: true, auction: this.toView(row) }
      : failure(404, "AUCTION_NOT_FOUND", "Auction not found");
  }

  async getHistory(afterSequence: number, limit: number): Promise<HistoryResult> {
    const closed = await this.closeIfDue(Date.now());
    if (closed) this.publish(closed);
    const row = this.readAuctionRow();
    if (!row) return failure(404, "AUCTION_NOT_FOUND", "Auction not found");
    return {
      ok: true,
      auction: this.toView(row),
      events: this.readEvents(afterSequence, limit),
    };
  }

  async getRealtimeBootstrap(afterSequence?: number): Promise<RealtimeBootstrapResult> {
    const closed = await this.closeIfDue(Date.now());
    if (closed) this.publish(closed);
    const row = this.readAuctionRow();
    if (!row) return failure(404, "AUCTION_NOT_FOUND", "Auction not found");

    const resyncRequired =
      afterSequence !== undefined &&
      (afterSequence > row.version || row.version - afterSequence > REALTIME_CATCHUP_LIMIT);
    const events =
      afterSequence === undefined || resyncRequired
        ? []
        : this.readEvents(afterSequence, REALTIME_CATCHUP_LIMIT);
    return {
      ok: true,
      message: {
        type: "auction.snapshot",
        auction: this.toView(row),
        events,
        cursor: row.version,
        resyncRequired,
      },
    };
  }

  async startAuction(sellerId: string, idempotencyKey: string): Promise<AuctionActionResult> {
    const now = Date.now();
    const outcome = await this.ctx.storage.transaction(async (): Promise<AuctionActionOutcome> => {
      const row = this.readAuctionRow();
      if (!row)
        return {
          result: failure(404, "AUCTION_NOT_FOUND", "Auction not found"),
        };
      if (row.seller_id !== sellerId) {
        return {
          result: failure(403, "FORBIDDEN", "Only the seller can start this auction"),
        };
      }

      const replay = this.replayIdempotentRequest(sellerId, idempotencyKey, "start", "");
      if (replay) {
        if (row.state === "LIVE" && row.ends_at !== null) {
          await this.ctx.storage.setAlarm(row.ends_at);
        }
        return { result: replay };
      }
      if (row.state !== "DRAFT") {
        return {
          result: failure(409, "INVALID_STATE", "Only a draft auction can be started"),
        };
      }

      const endsAt = now + row.duration_seconds * 1_000;
      const sequence = row.version + 1;
      this.ctx.storage.sql.exec(
        "UPDATE auction SET state = 'LIVE', starts_at = ?, ends_at = ?, version = ? WHERE id = ?",
        now,
        endsAt,
        sequence,
        row.id,
      );
      const event = this.insertEvent(sequence, "auction.started", sellerId, now, { endsAt });
      const result = auctionActionSuccessSchema.parse({
        ok: true,
        auction: this.toView(this.requireAuctionRow()),
        event,
        replayed: false,
      });
      this.storeIdempotencyRecord(sellerId, idempotencyKey, "start", "", result, now);
      await this.ctx.storage.setAlarm(endsAt);
      return { result, published: result };
    });

    if (outcome.published) this.publish(outcome.published);
    return outcome.result;
  }

  async placeBid(
    bidderId: string,
    idempotencyKey: string,
    amountCents: number,
  ): Promise<AuctionActionResult> {
    const now = Date.now();
    const fingerprint = String(amountCents);
    const outcome = await this.ctx.storage.transaction(async (): Promise<AuctionActionOutcome> => {
      const row = this.readAuctionRow();
      if (!row)
        return {
          result: failure(404, "AUCTION_NOT_FOUND", "Auction not found"),
        };

      const replay = this.replayIdempotentRequest(bidderId, idempotencyKey, "bid", fingerprint);
      if (replay) {
        if (row.state === "LIVE" && row.ends_at !== null) {
          await this.ctx.storage.setAlarm(row.ends_at);
        }
        return { result: replay };
      }

      if (row.state === "LIVE" && row.ends_at !== null && row.ends_at <= now) {
        const closed = this.closeAtSync(now, "system", null);
        await this.ctx.storage.deleteAlarm();
        return {
          result: failure(409, "AUCTION_ENDED", "The auction has ended"),
          published: closed ?? undefined,
        };
      }
      if (row.state !== "LIVE" || row.ends_at === null) {
        return {
          result: failure(
            409,
            "AUCTION_NOT_LIVE",
            "Bids are accepted only while the auction is live",
          ),
        };
      }

      const minimum =
        row.current_price_cents === null
          ? row.start_price_cents
          : row.current_price_cents + row.min_increment_cents;
      if (amountCents < minimum) {
        return {
          result: failure(409, "BID_TOO_LOW", `Bid must be at least ${minimum} cents`),
        };
      }

      const sequence = row.version + 1;
      const bidId = crypto.randomUUID();
      const shouldExtend =
        row.anti_snipe_window_seconds > 0 &&
        row.extension_seconds > 0 &&
        row.ends_at - now <= row.anti_snipe_window_seconds * 1_000;
      const endsAt = shouldExtend ? row.ends_at + row.extension_seconds * 1_000 : row.ends_at;

      this.ctx.storage.sql.exec(
        "INSERT INTO bids (id, bidder_id, amount_cents, sequence, accepted_at) VALUES (?, ?, ?, ?, ?)",
        bidId,
        bidderId,
        amountCents,
        sequence,
        now,
      );
      this.ctx.storage.sql.exec(
        `UPDATE auction SET current_price_cents = ?, leader_id = ?, bid_count = bid_count + 1,
         version = ?, ends_at = ? WHERE id = ?`,
        amountCents,
        bidderId,
        sequence,
        endsAt,
        row.id,
      );
      const event = this.insertEvent(sequence, "bid.accepted", bidderId, now, {
        bidId,
        amountCents,
        extended: shouldExtend,
        endsAt,
      });
      const result = auctionActionSuccessSchema.parse({
        ok: true,
        auction: this.toView(this.requireAuctionRow()),
        event,
        replayed: false,
      });
      this.storeIdempotencyRecord(bidderId, idempotencyKey, "bid", fingerprint, result, now);
      if (shouldExtend) await this.ctx.storage.setAlarm(endsAt);
      return { result, published: result };
    });

    if (outcome.published) this.publish(outcome.published);
    return outcome.result;
  }

  async closeAuction(sellerId: string, idempotencyKey: string): Promise<AuctionActionResult> {
    const now = Date.now();
    const outcome = await this.ctx.storage.transaction(async (): Promise<AuctionActionOutcome> => {
      const row = this.readAuctionRow();
      if (!row)
        return {
          result: failure(404, "AUCTION_NOT_FOUND", "Auction not found"),
        };
      if (row.seller_id !== sellerId) {
        return {
          result: failure(403, "FORBIDDEN", "Only the seller can close this auction"),
        };
      }

      const replay = this.replayIdempotentRequest(sellerId, idempotencyKey, "close", "");
      if (replay) return { result: replay };
      if (row.state === "CLOSED") {
        return {
          result: failure(409, "ALREADY_CLOSED", "The auction is already closed"),
        };
      }
      if (row.state !== "LIVE" || row.ends_at === null) {
        return {
          result: failure(409, "INVALID_STATE", "Only a live auction can be closed"),
        };
      }
      if (row.ends_at > now) {
        return {
          result: failure(
            409,
            "AUCTION_NOT_ENDED",
            "The seller cannot close the auction before its deadline",
          ),
        };
      }

      const result = this.closeAtSync(now, sellerId, {
        actorId: sellerId,
        idempotencyKey,
        actionType: "close",
      });
      if (!result) {
        return {
          result: failure(409, "INVALID_STATE", "The auction could not be closed"),
        };
      }
      await this.ctx.storage.deleteAlarm();
      return { result, published: result };
    });

    if (outcome.published) this.publish(outcome.published);
    return outcome.result;
  }

  async cancelAuction(sellerId: string, idempotencyKey: string): Promise<AuctionActionResult> {
    const now = Date.now();
    const outcome = await this.ctx.storage.transaction(async (): Promise<AuctionActionOutcome> => {
      const row = this.readAuctionRow();
      if (!row)
        return {
          result: failure(404, "AUCTION_NOT_FOUND", "Auction not found"),
        };
      if (row.seller_id !== sellerId) {
        return {
          result: failure(403, "FORBIDDEN", "Only the seller can cancel this auction"),
        };
      }

      const replay = this.replayIdempotentRequest(sellerId, idempotencyKey, "cancel", "");
      if (replay) return { result: replay };
      if (row.state !== "DRAFT" && row.state !== "LIVE") {
        return {
          result: failure(409, "INVALID_STATE", "Only a draft or live auction can be cancelled"),
        };
      }

      const sequence = row.version + 1;
      this.ctx.storage.sql.exec(
        "UPDATE auction SET state = 'CANCELLED', version = ?, closed_at = ? WHERE id = ?",
        sequence,
        now,
        row.id,
      );
      const event = this.insertEvent(sequence, "auction.cancelled", sellerId, now, {});
      const result = auctionActionSuccessSchema.parse({
        ok: true,
        auction: this.toView(this.requireAuctionRow()),
        event,
        replayed: false,
      });
      this.storeIdempotencyRecord(sellerId, idempotencyKey, "cancel", "", result, now);
      await this.ctx.storage.deleteAlarm();
      return { result, published: result };
    });

    if (outcome.published) this.publish(outcome.published);
    return outcome.result;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const row = this.readAuctionRow();
    if (!row || row.state !== "LIVE" || row.ends_at === null) return;
    if (row.ends_at > now) {
      await this.ctx.storage.setAlarm(row.ends_at);
      return;
    }
    const closed = await this.closeIfDue(now);
    if (closed) this.publish(closed);
  }

  private async closeIfDue(now: number): Promise<AuctionActionSuccess | null> {
    const row = this.readAuctionRow();
    if (!row || row.state !== "LIVE" || row.ends_at === null || row.ends_at > now) return null;
    return this.ctx.storage.transaction(async () => {
      const closed = this.closeAtSync(now, "system", null);
      await this.ctx.storage.deleteAlarm();
      return closed;
    });
  }

  private closeAtSync(
    now: number,
    actorId: string,
    idempotency: {
      actorId: string;
      idempotencyKey: string;
      actionType: "close";
    } | null,
  ): AuctionActionSuccess | null {
    const row = this.readAuctionRow();
    if (!row || row.state !== "LIVE") return null;
    const sequence = row.version + 1;
    this.ctx.storage.sql.exec(
      `UPDATE auction SET state = 'CLOSED', version = ?, closed_at = ?,
       winner_id = leader_id WHERE id = ?`,
      sequence,
      now,
      row.id,
    );
    const event = this.insertEvent(sequence, "auction.closed", actorId, now, {
      winnerId: row.leader_id,
      amountCents: row.current_price_cents,
    });
    const result = auctionActionSuccessSchema.parse({
      ok: true,
      auction: this.toView(this.requireAuctionRow()),
      event,
      replayed: false,
    });
    if (idempotency) {
      this.storeIdempotencyRecord(
        idempotency.actorId,
        idempotency.idempotencyKey,
        idempotency.actionType,
        "",
        result,
        now,
      );
    }
    return result;
  }

  private replayIdempotentRequest(
    actorId: string,
    key: string,
    actionType: string,
    fingerprint: string,
  ): AuctionActionResult | null {
    const raw = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT action_type, request_fingerprint, event_sequence, response_json
         FROM idempotency_records WHERE actor_id = ? AND idempotency_key = ?`,
        actorId,
        key,
      )
      .toArray()[0];
    if (!raw) return null;
    const stored: IdempotencyRecord = idempotencyRecordSchema.parse(sqlRowSchema.parse(raw));
    if (stored.action_type !== actionType || stored.request_fingerprint !== fingerprint) {
      return failure(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "The idempotency key was already used for a different request",
      );
    }
    const original = auctionActionSuccessSchema.parse(JSON.parse(stored.response_json));
    return { ...original, replayed: true };
  }

  private storeIdempotencyRecord(
    actorId: string,
    key: string,
    actionType: string,
    fingerprint: string,
    response: AuctionActionSuccess,
    createdAt: number,
  ): void {
    const verified = auctionActionSuccessSchema.parse(response);
    this.ctx.storage.sql.exec(
      `INSERT INTO idempotency_records (
        actor_id, idempotency_key, action_type, request_fingerprint,
        event_sequence, created_at, response_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      actorId,
      key,
      actionType,
      fingerprint,
      verified.event.sequence,
      createdAt,
      JSON.stringify(verified),
    );
  }

  private insertEvent<Type extends AuctionEventType>(
    sequence: number,
    type: Type,
    actorId: string,
    occurredAt: number,
    payload: EventPayloadByType[Type],
  ): AuctionEvent {
    const verifiedPayload = eventPayloadSchemas[type].parse(payload);
    const event = auctionEventSchema.parse({
      sequence,
      type,
      actorId,
      occurredAt,
      payload: verifiedPayload,
    });
    this.ctx.storage.sql.exec(
      "INSERT INTO events (sequence, type, actor_id, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?)",
      sequence,
      type,
      actorId,
      occurredAt,
      JSON.stringify(verifiedPayload),
    );
    return event;
  }

  private readEvents(afterSequence: number, limit: number): AuctionEvent[] {
    return this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT sequence, type, actor_id, occurred_at, payload_json
         FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`,
        afterSequence,
        limit,
      )
      .toArray()
      .map((row) => this.toEvent(eventRowSchema.parse(sqlRowSchema.parse(row))));
  }

  private readEvent(sequence: number): AuctionEvent | null {
    const row = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT sequence, type, actor_id, occurred_at, payload_json FROM events WHERE sequence = ?",
        sequence,
      )
      .toArray()[0];
    return row ? this.toEvent(eventRowSchema.parse(sqlRowSchema.parse(row))) : null;
  }

  private toEvent(row: EventRow): AuctionEvent {
    return auctionEventSchema.parse({
      sequence: row.sequence,
      type: row.type,
      actorId: row.actor_id,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json),
    });
  }

  private readAuctionRow(): AuctionRow | null {
    const row = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>("SELECT * FROM auction LIMIT 1")
      .toArray()[0];
    return row ? auctionRowSchema.parse(sqlRowSchema.parse(row)) : null;
  }

  private requireAuctionRow(): AuctionRow {
    const row = this.readAuctionRow();
    if (!row) throw new Error("Auction row is missing");
    return row;
  }

  private toView(row: AuctionRow): AuctionView {
    return auctionViewSchema.parse({
      id: row.id,
      sellerId: row.seller_id,
      title: row.title,
      currency: row.currency,
      state: row.state satisfies AuctionState,
      startPriceCents: row.start_price_cents,
      currentPriceCents: row.current_price_cents,
      nextMinimumBidCents:
        row.current_price_cents === null
          ? row.start_price_cents
          : row.current_price_cents + row.min_increment_cents,
      minIncrementCents: row.min_increment_cents,
      leaderId: row.leader_id,
      bidCount: row.bid_count,
      version: row.version,
      durationSeconds: row.duration_seconds,
      antiSnipeWindowSeconds: row.anti_snipe_window_seconds,
      extensionSeconds: row.extension_seconds,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      closedAt: row.closed_at,
      winnerId: row.winner_id,
    });
  }

  private matchesCreate(
    row: AuctionRow,
    auctionId: string,
    sellerId: string,
    input: CreateAuctionInput,
  ): boolean {
    return (
      row.id === auctionId &&
      row.seller_id === sellerId &&
      row.title === input.title &&
      row.currency === input.currency &&
      row.start_price_cents === input.startPriceCents &&
      row.min_increment_cents === input.minIncrementCents &&
      row.duration_seconds === input.durationSeconds &&
      row.anti_snipe_window_seconds === input.antiSnipeWindowSeconds &&
      row.extension_seconds === input.extensionSeconds
    );
  }

  private publish(result: AuctionActionSuccess): void {
    const message: RealtimeEventMessage = realtimeEventMessageSchema.parse({
      type: "auction.event",
      auction: result.auction,
      event: result.event,
      cursor: result.event.sequence,
    });
    const deliveries = Array.from({ length: FANOUT_SHARD_COUNT }, (_, shard) =>
      this.env.AUCTION_FANOUT.getByName(`${result.auction.id}:${shard}`).publish(message),
    );
    this.ctx.waitUntil(
      Promise.allSettled(deliveries).then((settled) => {
        const rejected = settled.filter((delivery) => delivery.status === "rejected");
        if (rejected.length > 0) {
          console.error(
            JSON.stringify({
              level: "error",
              message: "Realtime fanout delivery failed",
              auctionId: result.auction.id,
              sequence: result.event.sequence,
              failedShards: rejected.length,
            }),
          );
        }
      }),
    );
  }
}
