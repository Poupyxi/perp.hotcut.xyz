import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { DevnetBanner } from "@/components/app/gacha/DevnetBanner";
import { AgeGateModal, useAgeGate } from "@/components/app/gacha/AgeGate";
import { PingooProviders, usePingooWalletError } from "@/components/app/gacha/PingooProviders";
import { PingooMachine } from "@/components/app/gacha/PingooMachine";

export const Route = createFileRoute("/_app/gacha")({
  component: GachaPage,
  head: () => ({ meta: [{ title: "Gacha (devnet) — Perp RWA" }] }),
});

function GachaPage() {
  const { confirmed, confirm } = useAgeGate();
  const { walletError, setWalletError, clearWalletError } = usePingooWalletError();

  return (
    <div className="space-y-4">
      <DevnetBanner />
      {confirmed === false && <AgeGateModal onConfirm={confirm} />}
      <PingooProviders onWalletError={setWalletError}>
        <PingooMachine walletConnectionError={walletError} clearWalletConnectionError={clearWalletError} />
      </PingooProviders>
    </div>
  );
}
