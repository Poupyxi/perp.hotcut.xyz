import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";

const STORAGE_KEY = "perp-rwa.gacha.agegate.v1";

export function useAgeGate() {
  const [confirmed, setConfirmed] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      setConfirmed(window.localStorage.getItem(STORAGE_KEY) === "true");
    } catch {
      setConfirmed(false);
    }
  }, []);

  const confirm = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, "true");
    } catch {
      /* ignore */
    }
    setConfirmed(true);
  };

  return { confirmed, confirm };
}

export function AgeGateModal({ onConfirm }: { onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="w-full max-w-md mx-4 rounded-lg border border-border bg-card p-6 shadow-lg">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 ring-1 ring-amber-500/30 text-amber-400">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <h2 className="text-lg font-semibold tracking-tight">Confirmation</h2>
        </div>

        <div className="mt-4 space-y-3 text-sm text-muted-foreground">
          <p>
            Cette page contient un mécanisme de tirage avec valeur. Elle est destinée uniquement à
            des adultes (18+) et tourne <strong className="text-foreground">exclusivement sur Solana devnet</strong>.
          </p>
          <p>
            Les SOL utilisés ici n'ont aucune valeur réelle. Aucun argent réel ne circule.
          </p>
          <p className="text-xs">
            En cliquant sur "J'ai 18 ans ou plus, je continue", tu confirmes ton âge et reconnais
            que cette version est un prototype technique de test.
          </p>
        </div>

        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={onConfirm}
            className="h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition"
          >
            J'ai 18 ans ou plus, je continue
          </button>
          <a
            href="/"
            className="h-10 rounded-md border border-border bg-surface text-sm text-muted-foreground hover:text-foreground hover:bg-surface-raised flex items-center justify-center transition"
          >
            Quitter
          </a>
        </div>
      </div>
    </div>
  );
}
