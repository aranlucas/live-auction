import { createFileRoute } from "@tanstack/react-router";
import { roomSearchSchema } from "#/lib/room-config";
import { AuctionRoomPage } from "#/components/auction-room-page";

export const Route = createFileRoute("/")({
  validateSearch: roomSearchSchema,
  component: HomeRoute,
});

export function HomeRoute() {
  const search = Route.useSearch();

  return <AuctionRoomPage routeApiBaseUrl={search.api} />;
}
