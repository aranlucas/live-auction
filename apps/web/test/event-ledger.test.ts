import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { AuctionEvent } from "cloudflare-live-auction/model";
import { EventLedger } from "../src/components/event-ledger";

function event(sequence: number): AuctionEvent {
  return {
    type: "auction.cancelled",
    sequence,
    actorId: `seller-${sequence}`,
    occurredAt: sequence,
    payload: {},
  };
}

it("freezes the current events when paused and catches up when resumed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);

  const render = async (events: AuctionEvent[]) => {
    await act(async () => {
      root.render(createElement(EventLedger, { events, connected: true }));
    });
  };

  try {
    await render([event(1)]);
    await render([event(1), event(2)]);
    expect(container.textContent).toContain("seller-2");
    await act(async () => {
      container.querySelector("button")?.click();
    });
    await render([event(1), event(2), event(3)]);
    expect(container.textContent).toContain("seller-2");
    expect(container.textContent).not.toContain("seller-3");
    await act(async () => {
      container.querySelector("button")?.click();
    });
    expect(container.textContent).toContain("seller-3");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
