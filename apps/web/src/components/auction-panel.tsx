import { useEffect, useState } from "react";
import { differenceInSeconds } from "date-fns";
import { useForm } from "@tanstack/react-form";
import {
  CircleDollarSign,
  Clock3,
  Gavel,
  LoaderCircle,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { AuctionView } from "cloudflare-live-auction/model";
import { currency } from "#/lib/format";

interface AuctionPanelProps {
  auction: AuctionView | null;
  bidderLabel: string;
  hasSellerToken: boolean;
  hasBidderToken: boolean;
  hasCredentials: boolean;
  launchingDemo: boolean;
  pendingAction: string | null;
  onBid: (amountCents: number) => Promise<void>;
  onCreate: () => Promise<void>;
  onCommand: (action: "start" | "close" | "cancel") => Promise<void>;
  onLaunchDemo: () => Promise<boolean>;
  onOpenSetup: () => void;
}

function useRemainingSeconds(endsAt: number | null | undefined): number {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    const update = () =>
      setRemaining(endsAt ? Math.max(0, differenceInSeconds(endsAt, Date.now())) : 0);
    update();
    const interval = window.setInterval(update, 250);
    return () => window.clearInterval(interval);
  }, [endsAt]);
  return remaining;
}

function CountdownRing({ seconds, total }: { seconds: number; total: number }) {
  const progress = total > 0 ? Math.min(1, seconds / total) : 0;
  const circumference = 2 * Math.PI * 48;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return (
    <div className={`countdown-ring ${seconds <= 10 ? "is-urgent" : ""}`}>
      <svg viewBox="0 0 112 112" aria-hidden="true">
        <circle className="ring-track" cx="56" cy="56" r="48" />
        <circle
          className="ring-progress"
          cx="56"
          cy="56"
          r="48"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
        />
      </svg>
      <time>{`${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`}</time>
    </div>
  );
}

export function AuctionPanel({
  auction,
  bidderLabel,
  hasSellerToken,
  hasBidderToken,
  hasCredentials,
  launchingDemo,
  pendingAction,
  onBid,
  onCreate,
  onCommand,
  onLaunchDemo,
  onOpenSetup,
}: AuctionPanelProps) {
  const remainingSeconds = useRemainingSeconds(auction?.endsAt);
  const nextMinimum = auction?.nextMinimumBidCents ?? 10_000;
  const isLive = auction?.state === "LIVE";
  const form = useForm({
    defaultValues: { amount: (nextMinimum / 100).toFixed(0) },
    onSubmit: async ({ value }) => {
      const cents = Math.round(Number(value.amount) * 100);
      if (Number.isFinite(cents) && cents >= nextMinimum) await onBid(cents);
    },
  });

  useEffect(() => {
    form.setFieldValue("amount", (nextMinimum / 100).toFixed(0));
  }, [form, nextMinimum]);

  if (!auction) {
    return (
      <aside className="auction-panel empty-auction" aria-label="Auction controls">
        <div className="empty-auction-mark">
          {hasCredentials ? <Gavel size={34} /> : <Sparkles size={34} />}
        </div>
        <h1>{hasCredentials ? "No auction loaded" : "Start a live demo"}</h1>
        <p>
          {hasCredentials
            ? "Create the vintage-camera demo lot in this room."
            : "We’ll create a private test room, start the camera lot, and connect live updates. No tokens or terminal needed."}
        </p>
        {hasCredentials ? (
          <button
            className="primary-button"
            type="button"
            disabled={!hasSellerToken || Boolean(pendingAction)}
            onClick={() => void onCreate()}
          >
            {pendingAction === "create" ? (
              <LoaderCircle className="spin" size={19} />
            ) : (
              <Gavel size={19} />
            )}
            Create demo lot
          </button>
        ) : (
          <button
            className="primary-button"
            type="button"
            disabled={launchingDemo}
            onClick={() => void onLaunchDemo()}
          >
            {launchingDemo ? <LoaderCircle className="spin" size={19} /> : <Sparkles size={19} />}
            {launchingDemo ? "Starting your room…" : "Launch instant demo"}
          </button>
        )}
        <span className="demo-note">Short-lived room · expires in 15 minutes</span>
        {!hasCredentials && (
          <button className="text-button" type="button" onClick={onOpenSetup}>
            Advanced setup
          </button>
        )}
      </aside>
    );
  }

  return (
    <aside className="auction-panel" aria-labelledby="auction-title">
      <div className="auction-title-row">
        <div>
          <span className={`state-label state-${auction.state.toLowerCase()}`}>
            {auction.state}
          </span>
          <h1 id="auction-title">{auction.title}</h1>
        </div>
        <span className="version-label">Sequence {auction.version}</span>
      </div>

      <div className="price-timer-row">
        <div className="current-price">
          <span>Current bid</span>
          <strong>{currency(auction.currentPriceCents, auction.currency)}</strong>
          <small>
            {auction.leaderId ? (
              <>
                leading: <em>{auction.leaderId}</em>
              </>
            ) : (
              "No bids yet"
            )}
          </small>
        </div>
        <CountdownRing seconds={remainingSeconds} total={auction.durationSeconds} />
      </div>

      <div className="minimum-line">
        <span>Next minimum</span>
        <strong>{currency(nextMinimum, auction.currency)}</strong>
      </div>
      <button
        className="bid-button"
        type="button"
        disabled={!isLive || !hasBidderToken || Boolean(pendingAction)}
        onClick={() => void onBid(nextMinimum)}
      >
        {pendingAction === "bid" ? (
          <LoaderCircle className="spin" size={23} />
        ) : (
          <Gavel size={23} strokeWidth={2.5} />
        )}
        {isLive ? `Bid ${currency(nextMinimum, auction.currency)}` : "Bidding unavailable"}
      </button>
      <div className="bidder-identity">
        <ShieldCheck size={14} />
        Bidding as {bidderLabel}
      </div>

      <form
        className="custom-bid"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="amount">
          {(field) => (
            <label>
              Custom bid
              <span className="money-input">
                <CircleDollarSign size={17} />
                <input
                  type="number"
                  min={nextMinimum / 100}
                  step="1"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </span>
            </label>
          )}
        </form.Field>
        <button
          className="secondary-button"
          type="submit"
          disabled={!isLive || !hasBidderToken || Boolean(pendingAction)}
        >
          Place bid
        </button>
      </form>

      <div className="seller-controls">
        <div className="seller-heading">
          <span>Seller controls</span>
          {!hasSellerToken && (
            <button className="text-button" type="button" onClick={onOpenSetup}>
              Add token
            </button>
          )}
        </div>
        <div className="seller-actions">
          {auction.state === "DRAFT" ? (
            <button
              className="secondary-button"
              type="button"
              disabled={!hasSellerToken || Boolean(pendingAction)}
              onClick={() => void onCommand("start")}
            >
              <Play size={17} /> Start lot
            </button>
          ) : (
            <button
              className="secondary-button"
              type="button"
              disabled={
                auction.state !== "LIVE" ||
                remainingSeconds > 0 ||
                !hasSellerToken ||
                Boolean(pendingAction)
              }
              onClick={() => void onCommand("close")}
            >
              <Clock3 size={17} /> Close ended lot
            </button>
          )}
          <button
            className="secondary-button danger-button"
            type="button"
            disabled={
              !["DRAFT", "LIVE"].includes(auction.state) ||
              !hasSellerToken ||
              Boolean(pendingAction)
            }
            onClick={() => void onCommand("cancel")}
          >
            {pendingAction === "cancel" ? (
              <RotateCcw className="spin" size={17} />
            ) : (
              <XCircle size={17} />
            )}
            Cancel lot
          </button>
        </div>
      </div>
    </aside>
  );
}
