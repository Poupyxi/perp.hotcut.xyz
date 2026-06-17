import { useMemo, useState, useCallback, type ReactNode } from "react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { clusterApiUrl } from "@solana/web3.js";

function readableWalletError(error: unknown) {
  const message = (error as Error)?.message || String(error || "Erreur de connexion inconnue");
  if (/User rejected|rejected the request|declined/i.test(message)) return "Connexion annulée dans le wallet.";
  if (/WalletNotReadyError|not ready|not installed/i.test(message)) return "Wallet non détecté. Vérifie que Phantom est installé, déverrouillé et autorisé.";
  if (/already pending|request already pending/i.test(message)) return "Une demande est déjà ouverte dans le wallet.";
  return message;
}

type Props = {
  children: ReactNode;
  onWalletError?: (msg: string) => void;
};

export function PingooProviders({ children, onWalletError }: Props) {
  const network = WalletAdapterNetwork.Devnet;
  const rpcUrl = typeof window !== "undefined"
    ? ((window as unknown as { __PINGOO_RPC__?: string }).__PINGOO_RPC__ || null)
    : null;
  const endpoint = useMemo(
    () => rpcUrl || clusterApiUrl(network),
    [rpcUrl, network],
  );
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  const handleError = useCallback(
    (error: unknown) => {
      console.error("Wallet adapter error:", error);
      onWalletError?.(readableWalletError(error));
    },
    [onWalletError],
  );

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <WalletProvider
        wallets={wallets}
        autoConnect={false}
        onError={handleError}
        localStorageKey="pingoo-wallet-adapter"
      >
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}

export function usePingooWalletError() {
  const [walletError, setWalletError] = useState("");
  return { walletError, setWalletError, clearWalletError: () => setWalletError("") };
}
