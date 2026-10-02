import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
// The package's public entry point is CommonJS and Vite 8/Rolldown currently wraps its default
// export as a namespace in production. Use the package's named compiled modules until it publishes
// an ESM export map; this keeps both Vite and TypeScript on the maintained library implementation.
import { ReadyState } from "react-use-websocket/dist/lib/constants.js";
import { useWebSocket } from "react-use-websocket/dist/lib/use-websocket.js";
import {
  realtimeMessageSchema,
  readResultSchema,
  type AuctionEvent,
} from "cloudflare-live-auction/model";
import {
  bestReadToken,
  readAuction,
  readHistory,
  realtimeUrl,
  type TestRoomConfig,
} from "#/lib/auction-api";

const connectionLabels: Record<ReadyState, string> = {
  [ReadyState.CONNECTING]: "Connecting",
  [ReadyState.OPEN]: "Connected",
  [ReadyState.CLOSING]: "Closing",
  [ReadyState.CLOSED]: "Disconnected",
  [ReadyState.UNINSTANTIATED]: "Token needed",
};

export function useAuctionRoom(config: TestRoomConfig) {
  const queryClient = useQueryClient();
  const readToken = bestReadToken(config);
  const queryKey = useMemo(
    () => ["auction", config.apiBaseUrl, config.auctionId, readToken] as const,
    [config.apiBaseUrl, config.auctionId, readToken],
  );
  const historyKey = useMemo(
    () => ["auction-history", config.apiBaseUrl, config.auctionId, readToken] as const,
    [config.apiBaseUrl, config.auctionId, readToken],
  );

  const auctionQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => readAuction(config, readToken, signal),
    // Both HTTP completions and socket writes pass through this cache-commit seam.
    // Comparing here (rather than when a request starts) keeps the greatest version.
    structuralSharing: (previous, incoming) => {
      const current = readResultSchema.safeParse(previous);
      const next = readResultSchema.parse(incoming);
      return current.success &&
        current.data.ok &&
        next.ok &&
        current.data.auction.id === next.auction.id &&
        current.data.auction.version >= next.auction.version
        ? previous
        : incoming;
    },
    enabled: Boolean(readToken && config.auctionId),
    refetchInterval: 10_000,
  });
  const historyQuery = useQuery({
    queryKey: historyKey,
    queryFn: ({ signal }) => readHistory(config, readToken, signal),
    enabled: Boolean(readToken && config.auctionId && auctionQuery.data?.ok),
    refetchInterval: 15_000,
  });

  const socketUrl = useMemo(
    () => (readToken && config.auctionId && auctionQuery.data?.ok ? realtimeUrl(config) : null),
    [auctionQuery.data?.ok, config, readToken],
  );
  // The socket library keys connections by URL, not protocols. A URL function also
  // changes identity when credentials change, including when the next query is cached.
  const socketEndpoint = useMemo(
    () => (socketUrl ? () => socketUrl : null),
    [socketUrl, readToken],
  );
  const { readyState, getWebSocket } = useWebSocket(socketEndpoint, {
    onMessage: (message) => {
      // A retained lastMessage must never be replayed into another room's query key.
      const socket = getWebSocket();
      if (
        message.target !== socket ||
        socket?.readyState !== ReadyState.OPEN ||
        typeof message.data !== "string"
      )
        return;
      let value: unknown;
      try {
        value = JSON.parse(message.data);
      } catch {
        return;
      }
      const parsed = realtimeMessageSchema.safeParse(value);
      if (!parsed.success || parsed.data.auction.id !== config.auctionId) return;
      queryClient.setQueryData(
        queryKey,
        readResultSchema.parse({ ok: true, auction: parsed.data.auction }),
      );
      void queryClient.invalidateQueries({ queryKey: historyKey });
    },
    protocols: readToken ? ["auction.v1", `auth.${readToken}`] : undefined,
    shouldReconnect: () => true,
    reconnectAttempts: 20,
    reconnectInterval: (attempt) => Math.min(500 * 2 ** attempt, 10_000),
    retryOnError: true,
    heartbeat: {
      message: "ping",
      returnMessage: "pong",
      interval: 20_000,
      timeout: 30_000,
    },
  });

  const events: AuctionEvent[] = historyQuery.data?.ok ? historyQuery.data.events : [];

  return {
    auctionQuery,
    historyQuery,
    auction: auctionQuery.data?.ok ? auctionQuery.data.auction : null,
    events,
    connectionLabel: connectionLabels[readyState],
    connected: readyState === ReadyState.OPEN,
  };
}
