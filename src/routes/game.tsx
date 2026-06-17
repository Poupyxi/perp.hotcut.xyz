// Standalone public game page — served at /game on the backend.
// Nginx proxies game.hotcut.xyz/* → http://backend/game/* so this
// route handles all public game traffic without the dashboard sidebar.
import { createFileRoute } from "@tanstack/react-router";
import { DevnetBanner } from "@/components/app/gacha/DevnetBanner";
import { AgeGateModal, useAgeGate } from "@/components/app/gacha/AgeGate";
import { PingooProviders, usePingooWalletError } from "@/components/app/gacha/PingooProviders";
import { PingooMachine } from "@/components/app/gacha/PingooMachine";

export const Route = createFileRoute("/game")({
  component: GamePage,
  head: () => ({
    meta: [
      { title: "Pingoo — Tokenized Collectibles Gacha (Devnet)" },
      { name: "description", content: "Open tokenized collectible packs on Solana devnet." },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
});

function GamePage() {
  const { confirmed, confirm } = useAgeGate();
  const { walletError, setWalletError, clearWalletError } = usePingooWalletError();

  return (
    // Full-page standalone layout — no dashboard sidebar, no admin navigation.
    <div className="min-h-screen bg-background">
      <div className="space-y-4 p-4">
        <DevnetBanner />
        {confirmed === false && <AgeGateModal onConfirm={confirm} />}
        <PingooProviders onWalletError={setWalletError}>
          <PingooMachine
            walletConnectionError={walletError}
            clearWalletConnectionError={clearWalletError}
          />
        </PingooProviders>
      </div>
    </div>
  );
}
