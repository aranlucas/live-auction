import { defaultRoomConfig, testRoomConfigSchema, type TestRoomConfig } from "./auction-api";

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

  if (route.autoJoin || !stored) return fallback;

  try {
    const parsed = testRoomConfigSchema.safeParse(JSON.parse(stored));

    if (
      !parsed.success ||
      (route.routeAuctionId && parsed.data.auctionId !== route.routeAuctionId)
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
