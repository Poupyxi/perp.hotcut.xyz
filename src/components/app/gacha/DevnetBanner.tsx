import { AlertTriangle } from "lucide-react";

export function DevnetBanner() {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200 flex items-center gap-2.5">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>
        <strong className="font-semibold">Version de test — Solana devnet.</strong>{" "}
        Tous les SOL utilisés ici sont des jetons de test sans valeur. Aucun argent réel.
      </span>
    </div>
  );
}
