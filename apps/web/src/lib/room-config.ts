import { z } from "zod";
import { auctionIdSchema } from "cloudflare-live-auction/model";

export const testRoomConfigSchema = z.strictObject({
  apiBaseUrl: z.url(),
  auctionId: auctionIdSchema,
  sellerToken: z.string(),
  bidderToken: z.string(),
  viewerToken: z.string(),
});

export type TestRoomConfig = z.infer<typeof testRoomConfigSchema>;

export const defaultRoomConfig: TestRoomConfig = {
  apiBaseUrl: "https://cloudflare-live-auction-staging.aranlucas.workers.dev",
  auctionId: "gavel-live-demo",
  sellerToken: "",
  bidderToken: "",
  viewerToken: "",
};

export const roomSearchSchema = z.object({ api: z.url().optional() });

export interface RoomRoute {
  routeAuctionId?: string;
  routeApiBaseUrl?: string;
  autoJoin?: boolean;
}

export interface InitialRoomConfig {
  value: TestRoomConfig;
  restored: boolean;
}

export function restoreRoomConfig(route: RoomRoute, stored: string | null): InitialRoomConfig {
  const fallback: InitialRoomConfig = {
    value: {
      ...defaultRoomConfig,
      apiBaseUrl: route.routeApiBaseUrl ?? defaultRoomConfig.apiBaseUrl,
      auctionId: route.routeAuctionId ?? defaultRoomConfig.auctionId,
      sellerToken: route.autoJoin ? "" : defaultRoomConfig.sellerToken,
      bidderToken: route.autoJoin ? "" : defaultRoomConfig.bidderToken,
      viewerToken: route.autoJoin ? "" : defaultRoomConfig.viewerToken,
    },
    restored: false,
  };

  if (route.autoJoin || !stored) {
    return fallback;
  }

  try {
    const parsed = testRoomConfigSchema.safeParse(JSON.parse(stored));

    if (
      !parsed.success ||
      (route.routeAuctionId && parsed.data.auctionId !== route.routeAuctionId) ||
      (route.routeApiBaseUrl &&
        new URL(route.routeApiBaseUrl).href !== new URL(parsed.data.apiBaseUrl).href)
    ) {
      return fallback;
    }

    return {
      value: {
        ...parsed.data,
        apiBaseUrl: route.routeApiBaseUrl ?? parsed.data.apiBaseUrl,
        auctionId: route.routeAuctionId ?? parsed.data.auctionId,
      },
      restored: true,
    };
  } catch {
    return fallback;
  }
}
