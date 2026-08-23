import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AuctionRoomPage } from "#/components/auction-room-page";

const roomSearchSchema = z.object({ api: z.url().optional() });

export const Route = createFileRoute("/")({
  validateSearch: roomSearchSchema,
  component: HomeRoute,
});

function HomeRoute() {
  const search = Route.useSearch();
  return <AuctionRoomPage routeApiBaseUrl={search.api} />;
}
