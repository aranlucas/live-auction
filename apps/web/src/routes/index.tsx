import { lazy, Suspense, useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { auctionIdSchema } from "cloudflare-live-auction/model";
import { ActivityFeed } from "#/components/activity-feed";
import { AuctionPanel } from "#/components/auction-panel";
import { EventLedger } from "#/components/event-ledger";
import { LiveStage } from "#/components/live-stage";
import { RoomHeader } from "#/components/room-header";
import { useAuctionRoom } from "#/hooks/use-auction-room";
import {
  command,
  createAuction,
  defaultRoomConfig,
  errorMessage,
  placeBid,
  requestDemoSession,
  testRoomConfigSchema,
  type TestRoomConfig,
} from "#/lib/auction-api";
import { tokenSubject } from "#/lib/format";

const roomSearchSchema = z.object({
  api: z.url().optional(),
  auction: auctionIdSchema.optional(),
});

type RoomAction =
  | { type: "create" }
  | { type: "bid"; amountCents: number }
  | { type: "command"; action: "start" | "close" | "cancel" };

const storageKey = "gavel-live:test-room";
const SetupDialog = lazy(() =>
  import("#/components/setup-dialog").then((module) => ({ default: module.SetupDialog })),
);

export const Route = createFileRoute("/")({
  validateSearch: roomSearchSchema,
  component: AuctionRoom,
});

function AuctionRoom() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/" });
  const queryClient = useQueryClient();
  const [config, setConfig] = useState<TestRoomConfig>(() => ({
    ...defaultRoomConfig,
    ...(search.api ? { apiBaseUrl: search.api } : {}),
    ...(search.auction ? { auctionId: search.auction } : {}),
  }));
  const [setupOpen, setSetupOpen] = useState(false);

  useEffect(() => {
    const stored = window.sessionStorage.getItem(storageKey);
    if (!stored) return;
    try {
      const parsed = testRoomConfigSchema.parse(JSON.parse(stored));
      setConfig({
        ...parsed,
        ...(search.api ? { apiBaseUrl: search.api } : {}),
        ...(search.auction ? { auctionId: search.auction } : {}),
      });
    } catch {
      window.sessionStorage.removeItem(storageKey);
    }
  }, [search.api, search.auction]);

  const saveConfig = (nextConfig: TestRoomConfig) => {
    setConfig(nextConfig);
    window.sessionStorage.setItem(storageKey, JSON.stringify(nextConfig));
    void navigate({
      search: { api: nextConfig.apiBaseUrl, auction: nextConfig.auctionId },
      replace: true,
    });
  };

  const room = useAuctionRoom(config);
  const mutation = useMutation({
    mutationFn: async (action: RoomAction) => {
      if (action.type === "create") return createAuction(config);
      if (action.type === "bid") return placeBid(config, action.amountCents);
      return command(config, action.action);
    },
    onSuccess: async (result) => {
      toast.success(result.ok ? result.event.type : "Command completed");
      await queryClient.invalidateQueries({ queryKey: ["auction"] });
      await queryClient.invalidateQueries({ queryKey: ["auction-history"] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const launchMutation = useMutation({
    mutationFn: async () => {
      const nextConfig = await requestDemoSession(config.apiBaseUrl);
      saveConfig(nextConfig);
      await createAuction(nextConfig);
      await command(nextConfig, "start");
      return nextConfig;
    },
    onSuccess: async () => {
      toast.success("Your demo auction is live");
      await queryClient.invalidateQueries({ queryKey: ["auction"] });
      await queryClient.invalidateQueries({ queryKey: ["auction-history"] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const launchDemo = async () => {
    try {
      await launchMutation.mutateAsync();
      return true;
    } catch {
      // The mutation renders a toast and keeps the generated room available for retry.
      return false;
    }
  };

  const pendingAction = mutation.isPending
    ? mutation.variables.type === "command"
      ? mutation.variables.action
      : mutation.variables.type
    : null;

  const queryError = room.auctionQuery.error;
  const isMissing =
    queryError instanceof Error && queryError.message.toLowerCase().includes("not found");

  return (
    <div className="app-shell">
      <RoomHeader
        connectionLabel={room.connectionLabel}
        connected={room.connected}
        apiDocsUrl={new URL("/openapi.json", config.apiBaseUrl).toString()}
        onOpenSetup={() => setSetupOpen(true)}
      />

      <main className="room-layout" id="room">
        <div className="stage-column">
          <LiveStage auction={room.auction} />
          <ActivityFeed events={room.events} />
        </div>
        <div className="control-column">
          {queryError && !isMissing && (
            <div className="error-banner" role="alert">
              <AlertTriangle size={18} />
              <span>{errorMessage(queryError)}</span>
              <button type="button" onClick={() => void room.auctionQuery.refetch()}>
                <RefreshCw size={15} /> Retry
              </button>
            </div>
          )}
          <AuctionPanel
            auction={room.auction}
            bidderLabel={tokenSubject(config.bidderToken)}
            hasSellerToken={Boolean(config.sellerToken)}
            hasBidderToken={Boolean(config.bidderToken)}
            hasCredentials={Boolean(config.viewerToken || config.bidderToken || config.sellerToken)}
            launchingDemo={launchMutation.isPending}
            pendingAction={pendingAction}
            onBid={async (amountCents) => {
              await mutation.mutateAsync({ type: "bid", amountCents });
            }}
            onCreate={async () => {
              await mutation.mutateAsync({ type: "create" });
            }}
            onCommand={async (action) => {
              await mutation.mutateAsync({ type: "command", action });
            }}
            onLaunchDemo={launchDemo}
            onOpenSetup={() => setSetupOpen(true)}
          />
          <EventLedger events={room.events} connected={room.connected} />
        </div>
      </main>

      <Suspense fallback={null}>
        <SetupDialog
          config={config}
          open={setupOpen}
          onOpenChange={setSetupOpen}
          onSave={saveConfig}
          onLaunchDemo={launchDemo}
          launchingDemo={launchMutation.isPending}
        />
      </Suspense>
    </div>
  );
}
