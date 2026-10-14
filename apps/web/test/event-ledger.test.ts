import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { AuctionEvent } from "cloudflare-live-auction/model";
import { EventLedger } from "@/components/event-ledger";

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
    await act(() => {
      root.render(createElement(EventLedger, { events, connected: true }));

      return Promise.resolve();
    });
  };

  try {
    await render([event(1)]);
    await render([event(1), event(2)]);
    expect(container.textContent).toContain("seller-2");
    await act(() => {
      container.querySelector("button")?.click();

      return Promise.resolve();
    });
    await render([event(1), event(2), event(3)]);
    expect(container.textContent).toContain("seller-2");
    expect(container.textContent).not.toContain("seller-3");
    await act(() => {
      container.querySelector("button")?.click();

      return Promise.resolve();
    });
    expect(container.textContent).toContain("seller-3");
  } finally {
    await act(() => Promise.resolve(root.unmount()));
    vi.unstubAllGlobals();
  }
});
