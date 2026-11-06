import assert from "node:assert/strict";
import { expect } from "e2e";
import { test } from "@e2e-dev/web";
import { tokenFor } from "../test/helpers/auth";
import { auctionActionResultSchema, historyResultSchema } from "../src/model";

const api = "http://127.0.0.1:8787";

for (const blockedStorage of [false, true]) {
  test(`seller starts and bidder submits exact cents in EUR${blockedStorage ? " with blocked storage" : ""}`, async ({
    app,
    browser,
    screen,
  }) => {
    const auctionId = `e2e-${crypto.randomUUID()}`;
    const sellerToken = await tokenFor("e2e-seller", "seller", { auctionId });
    const bidderToken = await tokenFor("e2e-bidder", "bidder", { auctionId });
    const viewerToken = await tokenFor("e2e-viewer", "viewer", { auctionId });
    const created = await fetch(`${api}/v1/auctions/${auctionId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${sellerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Cent-priced camera",
        currency: "EUR",
        startPriceCents: 1025,
        minIncrementCents: 10,
        durationSeconds: 30,
        antiSnipeWindowSeconds: 0,
        extensionSeconds: 0,
      }),
    });
    assert.equal(created.status, 201);
    assert.equal(auctionActionResultSchema.parse(await created.json()).ok, true);

    if (blockedStorage) {
      await browser.addInitScript(() => {
        Storage.prototype.setItem = () => {
          throw new DOMException("Storage blocked", "SecurityError");
        };
      });
    }
    await app.open(`/?api=${encodeURIComponent(api)}`);
    await screen.getByRole("button", "Advanced setup", { exact: true }).tap();
    await browser.locator("details.advanced-setup > summary").tap();
    await screen.getByLabel("API base URL").fill(api);
    await screen.getByLabel("Auction ID", { exact: true }).fill(auctionId);
    await screen.getByLabel("Seller token").fill(sellerToken);
    await screen.getByLabel("Bidder token").fill(bidderToken);
    await screen.getByLabel("Viewer token").fill(viewerToken);
    await screen.getByRole("button", "Connect room", { exact: true }).tap();
    await expect(browser).toHaveURL(new RegExp(`/auctions/${auctionId}`));
    await expect(screen.getByRole("heading", "Cent-priced camera")).toBeVisible();
    await screen.getByRole("button", "Start lot", { exact: true }).tap();
    await expect(browser.locator(".state-label")).toHaveText("LIVE");
    await expect(screen.getByLabel("Custom bid")).toHaveValue("10.25");
    await screen.getByRole("button", "Place bid", { exact: true }).tap();
    await expect(browser.locator(".current-price strong")).toHaveText("€10.25");
    await expect(browser.locator(".activity-list")).toContainText(
      "e2e-bidder is leading with €10.25",
    );
    await expect(screen.getByLabel("Custom bid")).toHaveValue("10.35");
    await screen.getByLabel("Custom bid").fill("10.45");
    await screen.getByRole("button", "Place bid", { exact: true }).tap();
    await expect(browser.locator(".current-price strong")).toHaveText("€10.45");
    // Real Worker alarm/read closure: no clock mocks or external resources.
    await expect(browser.locator(".state-label")).toHaveText("CLOSED", { timeout: 60_000 });
    await expect(browser.locator(".activity-list")).toContainText("e2e-bidder won at €10.45");
    await expect(browser.locator(".event-ledger")).toContainText("winner=e2e-bidder amount=€10.45");
    const historyResponse = await fetch(`${api}/v1/auctions/${auctionId}/history`, {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    assert.equal(historyResponse.status, 200);
    const history = historyResultSchema.parse(await historyResponse.json());
    assert.ok(history.ok);
    assert.equal(history.auction.winnerId, "e2e-bidder");
    assert.equal(history.auction.currentPriceCents, 1045);
    assert.deepEqual(
      history.events.map((event) => event.type),
      ["auction.created", "auction.started", "bid.accepted", "bid.accepted", "auction.closed"],
    );
    assert.deepEqual(
      history.events
        .filter((event) => event.type === "bid.accepted")
        .map((event) => event.payload.amountCents),
      [1025, 1045],
    );
  });
}
