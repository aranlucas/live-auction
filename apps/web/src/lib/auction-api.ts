import { z } from "zod";
import {
  commandResultSchema,
  createAuctionInputSchema,
  demoBidderSessionResultSchema,
  demoSessionResultSchema,
  historyResultSchema,
  operationFailureSchema,
  readResultSchema,
  type CommandResult,
  type CreateAuctionInput,
  type HistoryResult,
  type ReadResult,
} from "cloudflare-live-auction/model";

export interface TestCredentials {
  sellerToken: string;
  bidderToken: string;
  viewerToken: string;
}

export interface TestRoomConfig extends TestCredentials {
  apiBaseUrl: string;
  auctionId: string;
}

export const testRoomConfigSchema = z.strictObject({
  apiBaseUrl: z.url(),
  auctionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  sellerToken: z.string(),
  bidderToken: z.string(),
  viewerToken: z.string(),
});

export const defaultRoomConfig: TestRoomConfig = {
  apiBaseUrl: "https://cloudflare-live-auction-staging.aranlucas.workers.dev",
  auctionId: "gavel-live-demo",
  sellerToken: "",
  bidderToken: "",
  viewerToken: "",
};

export const defaultAuctionInput: CreateAuctionInput = createAuctionInputSchema.parse({
  title: "Vintage Leica M3",
  currency: "USD",
  startPriceCents: 10_000,
  minIncrementCents: 1_000,
  durationSeconds: 300,
  antiSnipeWindowSeconds: 10,
  extensionSeconds: 10,
});

function apiEndpoint(apiBaseUrl: string, path: string): URL {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  return new URL(path.replace(/^\//, ""), base);
}

export class AuctionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function endpoint(config: TestRoomConfig, path = ""): URL {
  return apiEndpoint(
    config.apiBaseUrl,
    `v1/auctions/${encodeURIComponent(config.auctionId)}${path}`,
  );
}

export async function requestDemoSession(apiBaseUrl: string): Promise<TestRoomConfig> {
  const response = await fetch(apiEndpoint(apiBaseUrl, "/v1/demo-session"), {
    method: "POST",
  });
  const result = demoSessionResultSchema.parse(await response.json());
  if (!result.ok) {
    throw new AuctionApiError(result.error.status, result.error.code, result.error.message);
  }
  return {
    apiBaseUrl,
    auctionId: result.auctionId,
    sellerToken: result.sellerToken,
    bidderToken: result.bidderToken,
    viewerToken: result.viewerToken,
  };
}

export async function requestDemoBidderSession(
  apiBaseUrl: string,
  auctionId: string,
): Promise<TestRoomConfig> {
  const response = await fetch(
    apiEndpoint(apiBaseUrl, `/v1/demo-session/${encodeURIComponent(auctionId)}/bidder`),
    { method: "POST" },
  );
  const result = demoBidderSessionResultSchema.parse(await response.json());
  if (!result.ok) {
    throw new AuctionApiError(result.error.status, result.error.code, result.error.message);
  }
  return {
    apiBaseUrl,
    auctionId: result.auctionId,
    sellerToken: "",
    bidderToken: result.bidderToken,
    viewerToken: "",
  };
}

async function request<T>(
  schema: z.ZodType<T>,
  url: URL,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  const value: unknown = await response.json();
  const result = schema.parse(value);
  const failure = operationFailureSchema.safeParse(result);
  if (failure.success) {
    throw new AuctionApiError(
      failure.data.error.status,
      failure.data.error.code,
      failure.data.error.message,
    );
  }
  return result;
}

export function readAuction(config: TestRoomConfig, token: string): Promise<ReadResult> {
  return request(readResultSchema, endpoint(config), token);
}

export function readHistory(config: TestRoomConfig, token: string): Promise<HistoryResult> {
  const url = endpoint(config, "/history");
  url.searchParams.set("afterSequence", "0");
  url.searchParams.set("limit", "100");
  return request(historyResultSchema, url, token);
}

export function createAuction(
  config: TestRoomConfig,
  input: CreateAuctionInput = defaultAuctionInput,
): Promise<CommandResult> {
  return request(commandResultSchema, endpoint(config), config.sellerToken, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createAuctionInputSchema.parse(input)),
  });
}

export function command(
  config: TestRoomConfig,
  action: "start" | "close" | "cancel",
): Promise<CommandResult> {
  return request(commandResultSchema, endpoint(config, `/${action}`), config.sellerToken, {
    method: "POST",
    headers: { "Idempotency-Key": `${action}-${crypto.randomUUID()}` },
  });
}

export function placeBid(config: TestRoomConfig, amountCents: number): Promise<CommandResult> {
  return request(commandResultSchema, endpoint(config, "/bids"), config.bidderToken, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `bid-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ amountCents }),
  });
}

export function realtimeUrl(config: TestRoomConfig): string {
  const url = endpoint(config, "/events");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function bestReadToken(config: TestRoomConfig): string {
  return config.viewerToken || config.bidderToken || config.sellerToken;
}

export function errorMessage(error: unknown): string {
  if (error instanceof AuctionApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "The request failed";
}
