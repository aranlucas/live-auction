import { CircleCheck, Clock3, Gavel, Radio, UserRound } from "lucide-react";
import type { AuctionEvent } from "cloudflare-live-auction/model";
import { compactTime, currency } from "#/lib/format";

const eventIcon = {
  "auction.created": Radio,
  "auction.started": Gavel,
  "bid.accepted": CircleCheck,
  "auction.cancelled": Clock3,
  "auction.closed": Gavel,
} as const;

function eventCopy(event: AuctionEvent): { title: string; detail: string } {
  switch (event.type) {
    case "auction.created":
      return { title: "Lot created", detail: event.payload.title };
    case "auction.started":
      return {
        title: "Auction started",
        detail: `Ends at ${compactTime(event.payload.endsAt)}`,
      };
    case "bid.accepted":
      return {
        title: event.payload.extended ? "Bid accepted · deadline extended" : "Bid accepted",
        detail: `${event.actorId} is leading with ${currency(event.payload.amountCents)}`,
      };
    case "auction.cancelled":
      return {
        title: "Auction cancelled",
        detail: `Cancelled by ${event.actorId}`,
      };
    case "auction.closed":
      return {
        title: "Auction closed",
        detail: event.payload.winnerId
          ? `${event.payload.winnerId} won at ${currency(event.payload.amountCents)}`
          : "Closed without a winning bid",
      };
  }
}

export function ActivityFeed({ events }: { events: AuctionEvent[] }) {
  const activity = [...events].reverse();
  return (
    <section className="activity-panel" aria-labelledby="activity-title">
      <div className="panel-heading">
        <div>
          <h2 id="activity-title">Activity</h2>
          <p>Authoritative auction changes</p>
        </div>
        <span>{events.length} events</span>
      </div>
      <div className="activity-list">
        {activity.length === 0 ? (
          <div className="empty-activity">
            <UserRound size={20} />
            Connect a room to see bids and deadline changes here.
          </div>
        ) : (
          activity.slice(0, 7).map((event) => {
            const Icon = eventIcon[event.type];
            const copy = eventCopy(event);
            return (
              <article className={`activity-row event-${event.type}`} key={event.sequence}>
                <span className="activity-icon">
                  <Icon size={17} />
                </span>
                <div>
                  <strong>{copy.title}</strong>
                  <p>{copy.detail}</p>
                </div>
                <time dateTime={new Date(event.occurredAt).toISOString()}>
                  {compactTime(event.occurredAt)}
                </time>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
