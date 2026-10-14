import { describe, expect, it } from "vitest";
import { defaultRoomConfig } from "../src/lib/auction-api";
import { restoreRoomConfig } from "../src/lib/room-config";

const stored = JSON.stringify({
  ...defaultRoomConfig,
  auctionId: "saved-room",
  viewerToken: "saved-viewer",
  sellerToken: "saved-seller",
});

describe("room configuration restoration", () => {
  it("keeps the homepage defaults when there is no saved room", () => {
    expect(restoreRoomConfig({}, null)).toEqual({ value: defaultRoomConfig, restored: false });
  });

  it.each(["not-json", "{}"])("ignores invalid stored data: %s", (value) => {
    expect(restoreRoomConfig({}, value).restored).toBe(false);
  });

  it("restores saved credentials and honors the route API", () => {
    const result = restoreRoomConfig({ routeApiBaseUrl: "https://auction.test" }, stored);
    expect(result.restored).toBe(true);
    expect(result.value.auctionId).toBe("saved-room");
    expect(result.value.viewerToken).toBe("saved-viewer");
    expect(result.value.apiBaseUrl).toBe("https://auction.test");
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
