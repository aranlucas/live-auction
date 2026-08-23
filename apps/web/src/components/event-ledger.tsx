import { Pause, Play, Radio } from "lucide-react";
import { useEffect, useState } from "react";
import type { AuctionEvent } from "cloudflare-live-auction/model";
import { compactTime, currency } from "#/lib/format";

function eventDetail(event: AuctionEvent): string {
  switch (event.type) {
    case "auction.created":
      return `currency=${event.payload.currency} start=${event.payload.startPriceCents}`;
    case "auction.started":
      return `endsAt=${event.payload.endsAt}`;
    case "bid.accepted":
      return `bid=${event.payload.amountCents} bidder=${event.actorId}`;
    case "auction.cancelled":
      return `actor=${event.actorId}`;
    case "auction.closed":
      return event.payload.winnerId
        ? `winner=${event.payload.winnerId} amount=${currency(event.payload.amountCents)}`
        : "winner=null";
  }
}

export function EventLedger({ events, connected }: { events: AuctionEvent[]; connected: boolean }) {
  const [paused, setPaused] = useState(false);
  const [visibleEvents, setVisibleEvents] = useState(events);
  useEffect(() => {
    if (!paused) setVisibleEvents(events);
  }, [events, paused]);
  const rows = [...visibleEvents].reverse().slice(0, 8);

  return (
    <section className="event-ledger" id="events" aria-labelledby="events-title">
      <div className="ledger-heading">
        <div>
          <h2 id="events-title">System events</h2>
          <span className={connected ? "stream-live" : ""}>
            <Radio size={12} /> {connected ? "Live" : "Offline"}
          </span>
        </div>
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={() => {
            if (paused) setVisibleEvents(events);
            setPaused((value) => !value);
          }}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
          {paused ? "Resume" : "Pause"}
        </button>
      </div>
      <div className="ledger-scroll">
        <table>
          <thead>
            <tr>
              <th>Sequence</th>
              <th>Event type</th>
              <th>Details</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="empty-table">
                  No durable events yet
                </td>
              </tr>
            ) : (
              rows.map((event) => (
                <tr key={event.sequence}>
                  <td>{event.sequence}</td>
                  <td className={`type-${event.type}`}>{event.type}</td>
                  <td>{eventDetail(event)}</td>
                  <td>{compactTime(event.occurredAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
