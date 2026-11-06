import { describe, expect, it } from "vitest";
import { defaultRoomConfig, restoreRoomConfig } from "@/lib/room-config";

const stored = JSON.stringify({
  ...defaultRoomConfig,
  auctionId: "saved-room",
  viewerToken: "saved-viewer",
  sellerToken: "saved-seller",
  bidderToken: "saved-bidder",
});

describe("room configuration restoration", () => {
  it("keeps the homepage defaults when there is no saved room", () => {
    expect(restoreRoomConfig({}, null)).toEqual({ value: defaultRoomConfig, restored: false });
  });

  it.each(["not-json", "{}"])("ignores invalid stored data: %s", (value) => {
    expect(restoreRoomConfig({}, value).restored).toBe(false);
  });

  it("restores saved credentials for the saved API", () => {
    const result = restoreRoomConfig({ routeApiBaseUrl: defaultRoomConfig.apiBaseUrl }, stored);
    expect(result.restored).toBe(true);
    expect(result.value.auctionId).toBe("saved-room");
    expect(result.value.viewerToken).toBe("saved-viewer");
    expect(result.value.apiBaseUrl).toBe(defaultRoomConfig.apiBaseUrl);
  });

  it("does not send saved credentials to a route-selected API", () => {
    const result = restoreRoomConfig(
      {
        routeAuctionId: "saved-room",
        routeApiBaseUrl: "https://other-api.test",
      },
      stored,
    );

    expect(result.restored).toBe(false);
    expect(result.value.apiBaseUrl).toBe("https://other-api.test");
    expect(result.value.auctionId).toBe("saved-room");
    expect(result.value.viewerToken).toBe("");
    expect(result.value.sellerToken).toBe("");
    expect(result.value.bidderToken).toBe("");
  });

  it("does not reuse credentials when switching to a different auction", () => {
    const result = restoreRoomConfig({ routeAuctionId: "other-room" }, stored);
    expect(result.restored).toBe(false);
    expect(result.value.auctionId).toBe("other-room");
    expect(result.value.viewerToken).toBe("");
    expect(result.value.sellerToken).toBe("");
  });

  it("starts auto-join without saved credentials even for the same auction", () => {
    const result = restoreRoomConfig({ routeAuctionId: "saved-room", autoJoin: true }, stored);
    expect(result.restored).toBe(false);
    expect(result.value.viewerToken).toBe("");
    expect(result.value.sellerToken).toBe("");
    expect(result.value.bidderToken).toBe("");
  });
});
