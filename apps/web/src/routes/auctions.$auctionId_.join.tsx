import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { auctionIdSchema } from "cloudflare-live-auction/model";
import { AuctionRoomPage } from "#/components/auction-room-page";

const roomSearchSchema = z.object({ api: z.url().optional() });

export const Route = createFileRoute("/auctions/$auctionId_/join")({
  validateSearch: roomSearchSchema,
  component: JoinAuctionRoute,
});

function JoinAuctionRoute() {
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
