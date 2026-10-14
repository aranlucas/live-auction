import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
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
  requestDemoBidderSession,
  requestDemoSession,
  type TestRoomConfig,
} from "#/lib/auction-api";
import { restoreRoomConfig } from "#/lib/room-config";
import { tokenSubject } from "#/lib/format";

interface AuctionRoomPageProps {
  routeAuctionId?: string;
  routeApiBaseUrl?: string;
  autoJoin?: boolean;
}

type RoomAction =
  | { type: "create" }
  | { type: "bid"; amountCents: number }
  | { type: "command"; action: "start" | "close" | "cancel" };

const storageKey = "gavel-live:test-room";

const SetupDialog = lazy(() =>
  import("#/components/setup-dialog").then((module) => ({
    default: module.SetupDialog,
  })),
);

const subscribeToHydration = () => () => {};

const clientReady = () => true;

const serverReady = () => false;

export function AuctionRoomPage(props: AuctionRoomPageProps) {
  const storageReady = useSyncExternalStore(subscribeToHydration, clientReady, serverReady);

  return (
    <AuctionRoom
      key={`${String(props.autoJoin ?? false)}:${props.routeAuctionId ?? ""}:${props.routeApiBaseUrl ?? ""}:${String(storageReady)}`}
      {...props}
      storageReady={storageReady}
    />
  );
}

interface AuctionRoomProps extends AuctionRoomPageProps {
  storageReady: boolean;
}

function AuctionRoom({
  routeAuctionId,
  routeApiBaseUrl,
  autoJoin = false,
  storageReady,
}: AuctionRoomProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [initial] = useState(() => {
    const route = { routeAuctionId, routeApiBaseUrl, autoJoin };

    if (!storageReady) {
      return restoreRoomConfig(route, null);
    }

    try {
      return restoreRoomConfig(route, window.sessionStorage.getItem(storageKey));
    } catch {
      return restoreRoomConfig(route, null);
    }
  });

  const [config, setConfig] = useState(initial.value);

  const [setupOpen, setSetupOpen] = useState(false);
  const autoJoinStarted = useRef(false);

  const navigateToAuction = useCallback(
    (nextConfig: TestRoomConfig) => {
      navigate({
        to: "/auctions/$auctionId",
        params: { auctionId: nextConfig.auctionId },
        search: {
          api:
            nextConfig.apiBaseUrl === defaultRoomConfig.apiBaseUrl
              ? undefined
              : nextConfig.apiBaseUrl,
        },
        replace: true,
      }).catch(globalThis.reportError);
    },
    [navigate],
  );

  const saveConfig = useCallback(
    (nextConfig: TestRoomConfig) => {
      setConfig(nextConfig);
      window.sessionStorage.setItem(storageKey, JSON.stringify(nextConfig));
      navigateToAuction(nextConfig);
    },
    [navigateToAuction],
  );

  useEffect(() => {
    if (storageReady && initial.restored && !autoJoin && !routeAuctionId && config.auctionId) {
      navigateToAuction(config);
    }
  }, [autoJoin, config, initial.restored, navigateToAuction, routeAuctionId, storageReady]);

  const room = useAuctionRoom(config);

  const mutation = useMutation({
    mutationFn: (action: RoomAction) => {
      if (action.type === "create") {
        return createAuction(config);
      }

      if (action.type === "bid") {
        return placeBid(config, action.amountCents);
      }

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

  const joinMutation = useMutation({
    mutationFn: async () => {
      const auctionId = routeAuctionId ?? config.auctionId;
      const nextConfig = await requestDemoBidderSession(config.apiBaseUrl, auctionId);
      saveConfig(nextConfig);

      return nextConfig;
    },
    onSuccess: async (nextConfig) => {
      toast.success(`Joined as ${tokenSubject(nextConfig.bidderToken)}`);
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
      return false;
    }
  };

  const joinDemo = async () => {
    try {
      await joinMutation.mutateAsync();

      return true;
    } catch {
      return false;
    }
  };

  useEffect(() => {
    if (!storageReady || !autoJoin || !routeAuctionId || autoJoinStarted.current) {
      return;
    }

    autoJoinStarted.current = true;
    joinMutation.mutate();
  }, [autoJoin, joinMutation, routeAuctionId, storageReady]);

  const pendingAction = mutation.isPending
    ? mutation.variables.type === "command"
      ? mutation.variables.action
      : mutation.variables.type
    : null;

  const queryError = room.auctionQuery.error;

  const isMissing =
    queryError instanceof Error && queryError.message.toLowerCase().includes("not found");

  const isDemoAuction = (routeAuctionId ?? room.auction?.id)?.startsWith("demo-") ?? false;

  const additionalBidderUrl = room.auction?.id.startsWith("demo-")
    ? `/auctions/${encodeURIComponent(room.auction.id)}/join${
        config.apiBaseUrl === defaultRoomConfig.apiBaseUrl
          ? ""
          : `?api=${encodeURIComponent(config.apiBaseUrl)}`
      }`
    : undefined;

  return (
    <div className="app-shell">
      <RoomHeader
        connectionLabel={room.connectionLabel}
        connected={room.connected}
        apiDocsUrl={new URL("/openapi.json", config.apiBaseUrl).toString()}
        onOpenSetup={() => setSetupOpen(true)}
      />

      <main className="room-layout" id="room" tabIndex={-1}>
        <div className="stage-column">
          <LiveStage auction={room.auction} />
          <ActivityFeed events={room.events} />
        </div>
        <div className="control-column">
          {queryError && !isMissing ? (
            <div className="error-banner" role="alert">
              <AlertTriangle size={18} />
              <span>{errorMessage(queryError)}</span>
              <button type="button" onClick={() => void room.auctionQuery.refetch()}>
                <RefreshCw size={15} /> Retry
              </button>
            </div>
          ) : null}
          <AuctionPanel
            auction={room.auction}
            roomAuctionId={routeAuctionId}
            bidderLabel={tokenSubject(config.bidderToken)}
            hasSellerToken={Boolean(config.sellerToken)}
            hasBidderToken={Boolean(config.bidderToken)}
            hasCredentials={Boolean(config.viewerToken || config.bidderToken || config.sellerToken)}
            launchingDemo={launchMutation.isPending}
            joiningDemo={joinMutation.isPending}
            pendingAction={pendingAction}
            additionalBidderUrl={additionalBidderUrl}
            onBid={async (amountCents) => {
              await mutation.mutateAsync({ type: "bid", amountCents });
            }}
            onCreate={async () => {
              await mutation.mutateAsync({ type: "create" });
            }}
            onCommand={async (action) => {
              await mutation.mutateAsync({ type: "command", action });
            }}
            onJoinDemo={joinDemo}
            onLaunchDemo={launchDemo}
            onOpenSetup={() => setSetupOpen(true)}
            showJoinDemo={isDemoAuction && !config.bidderToken}
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
