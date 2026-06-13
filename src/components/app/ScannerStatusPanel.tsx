import { useEffect, useState } from "react";
import { RelativeTime } from "./RelativeTime";

type ScanStatus = {
  provider: string;
  scanType: string;
  status: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  itemsChecked: number;
  itemsFound: number;
  itemsStored: number;
  durationMs: number;
};

type ProviderStatusPayload = {
  scanner?: {
    dryRun?: boolean;
    enabled?: boolean;
    batchSize?: number;
    intervalSeconds?: number;
    newMintDiscoveryEnabled?: boolean;
    newMintDiscoveryLimitPerCollection?: number;
    scanStatuses?: ScanStatus[];
  };
};

function statusClass(status: string) {
  if (status === "live") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  if (status === "error") return "border-red-500/40 bg-red-500/10 text-red-300";
  return "border-border bg-surface text-muted-foreground";
}

export function ScannerStatusPanel() {
  const [payload, setPayload] = useState<ProviderStatusPayload | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/providers/status", {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        if (!response.ok) return;
        setPayload(await response.json() as ProviderStatusPayload);
      } catch {
        // Status panel is informational only.
      }
    }

    void load();
    const timer = window.setInterval(() => void load(), 120_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  const scanner = payload?.scanner;
  const latest = scanner?.scanStatuses?.[0] ?? null;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Scanner status</div>
          <div className="mt-1 text-sm font-medium">
            {scanner?.enabled === false ? "Scanner disabled" : scanner?.dryRun === false ? "Write mode enabled" : "Dry-run mode"}
          </div>
        </div>
        <span className={`rounded border px-2 py-1 text-xs ${statusClass(latest?.status ?? (scanner?.dryRun === false ? "live" : "unavailable"))}`}>
          {latest?.status ?? (scanner ? "ready" : "loading")}
        </span>
      </div>

      <div className="mt-4 grid gap-3 text-xs text-muted-foreground sm:grid-cols-4">
        <div>
          <div>Batch size</div>
          <div className="mt-1 font-mono text-foreground">{scanner?.batchSize ?? "..."}</div>
        </div>
        <div>
          <div>New mints limit</div>
          <div className="mt-1 font-mono text-foreground">{scanner?.newMintDiscoveryLimitPerCollection ?? "..."}</div>
        </div>
        <div>
          <div>Last checked</div>
          <div className="mt-1 text-foreground">{latest?.lastRunAt ? <RelativeTime iso={latest.lastRunAt} /> : "Not run"}</div>
        </div>
        <div>
          <div>Last result</div>
          <div className="mt-1 font-mono text-foreground">
            {latest ? `${latest.itemsChecked}/${latest.itemsFound}/${latest.itemsStored}` : "0/0/0"}
          </div>
        </div>
      </div>

      {latest?.lastError && <div className="mt-3 text-xs text-red-300">{latest.lastError}</div>}
    </div>
  );
}
