import { createFileRoute } from "@tanstack/react-router";
import { roomSearchSchema } from "#/lib/room-config";
import { auctionIdSchema } from "cloudflare-live-auction/model";
import { AuctionRoomPage } from "#/components/auction-room-page";

export const Route = createFileRoute("/auctions/$auctionId_/join")({
  validateSearch: roomSearchSchema,
  component: JoinAuctionRoute,
});

export function JoinAuctionRoute() {
  const { auctionId } = Route.useParams();
  const search = Route.useSearch();

  return (
    <AuctionRoomPage
      autoJoin
      routeAuctionId={auctionIdSchema.parse(auctionId)}
      routeApiBaseUrl={search.api}
    />
  );
}
