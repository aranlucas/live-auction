import { Image as ImageIcon, UsersRound } from "lucide-react";
import type { AuctionView } from "cloudflare-live-auction/model";

interface LiveStageProps {
  auction: AuctionView | null;
}

export function LiveStage({ auction }: LiveStageProps) {
  return (
    <section className="live-stage" aria-label="Auction stage">
      <img
        src="/host-camera-shop.png"
        alt="Demo still of a camera seller presenting a silver rangefinder camera"
      />
      <div className="stage-scrim" />
      <div className="stage-topline">
        <span className="stage-preview-label">
          <ImageIcon size={14} />
          Demo still
        </span>
        <span className="stage-context">
          <UsersRound size={15} />
          Test room · {auction ? `${auction.bidCount} accepted bids` : "waiting for auction"}
        </span>
      </div>
      <div className="host-lockup">
        <div className="host-avatar">MC</div>
        <div>
          <strong>Maya's Camera Club</strong>
          <span>Host · Maya Chen</span>
        </div>
      </div>
    </section>
  );
}
