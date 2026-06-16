import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { fmtCount, fmtUSD, realMarketCategories } from "@/lib/real-market-data";
import { RelativeTime } from "@/components/app/RelativeTime";
import { useMarketSales } from "@/lib/market-data/use-market-sales";
import type { MarketProvider, NormalizedSale, ProviderStatus } from "@/lib/market-data/types";
import { ArrowLeft, ExternalLink } from "lucide-react";

export const Route = createFileRoute("/_app/collections/$slug")({
  component: MarketDetail,
  loader: ({ params }) => {
    const market = realMarketCategories.find((c) => c.slug === params.slug);
    if (!market) throw notFound();
    return { market };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.market.name ?? "Market"} — Perp RWA` }],
  }),
  notFoundComponent: () => (
    <div className="text-center py-20">
      <h2 className="text-lg font-semibold">Market not found</h2>
      <Link to="/collections" className="mt-3 inline-block text-sm text-primary">Back to markets</Link>
    </div>
  ),
});

type ProviderFilter = "all" | MarketProvider;

type AssetRow = {
  assetName: string;
  assetImage?: string;
  grade?: string;
  lastSale?: NormalizedSale;
  saleCount: number;
  volumeUsd: number;
  providers: string[];
};

const providerLabels: Record<MarketProvider, string> = {
  "collector-crypt": "Provider not connected",
  "magic-eden": "Provider not connected",
  tensor: "Tensor",
  solscan: "Solscan",
  helius: "Helius",
  mock: "Stored feed",
};

function MarketDetail() {
  const { market } = Route.useLoaderData();
  const [provider, setProvider] = useState<ProviderFilter>("all");
  const { data, loading, error } = useMarketSales(7);

  const marketSales = useMemo(
    () => (data?.sales ?? []).filter((sale) => sale.marketSlug === market.slug),
    [data?.sales, market.slug],
  );
  const filteredSales = provider === "all" ? marketSales : marketSales.filter((sale) => sale.source === provider);
  const assetRows = useMemo(() => buildAssetRows(filteredSales), [filteredSales]);
  const trackedProviders = data?.providerStatus.map((status) => status.provider) ?? [];
  const activeProviders = Array.from(new Set([...trackedProviders, ...marketSales.map((sale) => sale.source)]));
  const providerOptions: ProviderFilter[] = ["all", ...activeProviders];

  return (
    <div className="space-y-6">
      <Link to="/collections" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3 w-3" /> Back to markets
      </Link>

      <div className="flex flex-col lg:flex-row gap-5 items-start">
        <div className="h-24 w-24 rounded-xl bg-primary/10 ring-1 ring-primary/20" />
        <div className="flex-1 min-w-0">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted-foreground">
            <span className={`h-1.5 w-1.5 rounded-full ${data?.live ? "bg-success animate-pulse" : "bg-muted-foreground"}`} />
            {data?.live ? "Live provider feed" : "Provider sales feed"}
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">{market.name}</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Track sold assets for this market across the providers we monitor. Rows are organized as market → asset → confirmed sale, with provider status and refresh cadence visible.
          </p>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <Stat label="Filtered NFT mints" value={fmtCount(market.assets)} />
        <Stat label="Collector Crypt" value={fmtCount(market.collectorCryptAssets)} />
        <Stat label="Phygitals" value={fmtCount(market.phygitalsAssets)} />
        <Stat label="7d confirmed sales" value={loading ? "..." : filteredSales.length.toString()} />
      </div>

      <ProviderStatusPanel statuses={data?.providerStatus ?? []} loading={loading} error={error} live={Boolean(data?.live)} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1 p-1 rounded-md bg-surface border border-border">
          {providerOptions.map((option) => (
            <button
              key={option}
              onClick={() => setProvider(option)}
              className={`text-xs px-3 py-1.5 rounded transition ${provider === option ? "bg-surface-raised text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {option === "all" ? "All providers" : providerLabels[option] ?? option}
            </button>
          ))}
        </div>
        <div className="text-xs text-muted-foreground font-mono">{assetRows.length} assets · {filteredSales.length} sales</div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="p-5 border-b border-border">
          <h2 className="text-sm font-semibold">Sold assets — {market.name}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Unique assets sold in the selected provider feed.</p>
        </div>
        {loading ? (
          <div className="p-8 text-sm text-muted-foreground">Loading market assets...</div>
        ) : assetRows.length === 0 ? (
          <div className="p-8 text-sm text-muted-foreground">No sold assets found for this market in the current 7-day window.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="text-left font-medium px-5 py-3">Asset</th>
                <th className="text-left font-medium px-5 py-3">Grade</th>
                <th className="text-right font-medium px-5 py-3">Sales</th>
                <th className="text-right font-medium px-5 py-3">Last sale</th>
                <th className="text-left font-medium px-5 py-3">Providers</th>
                <th className="text-right font-medium px-5 py-3">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {assetRows.map((asset) => (
                <tr key={asset.assetName} className="hover:bg-surface-raised/40 transition">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      {asset.assetImage ? <img src={asset.assetImage} alt="" className="h-9 w-9 rounded object-cover bg-muted" /> : <div className="h-9 w-9 rounded bg-muted" />}
                      <span className="font-medium">{asset.assetName}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">{asset.grade ?? "Verified"}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums">{asset.saleCount}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums font-semibold">{asset.lastSale ? formatSalePrice(asset.lastSale) : "-"}</td>
                  <td className="px-5 py-3 text-muted-foreground">{asset.providers.join(", ")}</td>
                  <td className="px-5 py-3 text-right"><AssetState sale={asset.lastSale} live={Boolean(data?.live)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="p-5 border-b border-border">
          <h2 className="text-sm font-semibold">Confirmed sales feed</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Latest executed sales for this market, grouped by provider and marketplace source.</p>
        </div>
        {loading ? (
          <div className="p-8 text-sm text-muted-foreground">Loading confirmed sales...</div>
        ) : filteredSales.length === 0 ? (
          <div className="p-8 text-sm text-muted-foreground">No confirmed sales for this provider filter.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="text-left font-medium px-5 py-3">Asset</th>
                <th className="text-left font-medium px-5 py-3">Provider</th>
                <th className="text-left font-medium px-5 py-3">Marketplace</th>
                <th className="text-left font-medium px-5 py-3">Grade</th>
                <th className="text-right font-medium px-5 py-3">Sale price</th>
                <th className="text-right font-medium px-5 py-3">Time</th>
                <th className="text-right font-medium px-5 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredSales.map((sale) => (
                <tr key={sale.id} className="hover:bg-surface-raised/40 transition">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      {sale.assetImage ? <img src={sale.assetImage} alt="" className="h-8 w-8 rounded object-cover bg-muted" /> : <div className="h-8 w-8 rounded bg-muted" />}
                      <span className="font-medium">{sale.assetName}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">{providerLabels[sale.source] ?? sale.source}</td>
                  <td className="px-5 py-3 text-muted-foreground">{sale.marketplace}</td>
                  <td className="px-5 py-3 text-muted-foreground">{sale.grade ?? "Verified"}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums font-semibold">{formatSalePrice(sale)}</td>
                  <td className="px-5 py-3 text-right text-muted-foreground text-xs"><RelativeTime iso={sale.saleTime} /></td>
                  <td className="px-5 py-3 text-right"><SaleStatus sale={sale} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function buildAssetRows(rows: NormalizedSale[]): AssetRow[] {
  const grouped = new Map<string, NormalizedSale[]>();
  for (const sale of rows) {
    const current = grouped.get(sale.assetName) ?? [];
    current.push(sale);
    grouped.set(sale.assetName, current);
  }

  return Array.from(grouped.entries()).map(([assetName, sales]) => {
    const sorted = [...sales].sort((a, b) => new Date(b.saleTime).getTime() - new Date(a.saleTime).getTime());
    const providers = Array.from(new Set(sorted.map((sale) => providerLabels[sale.source] ?? sale.source)));
    return {
      assetName,
      assetImage: sorted.find((sale) => sale.assetImage)?.assetImage,
      grade: sorted.find((sale) => sale.grade)?.grade,
      lastSale: sorted[0],
      saleCount: sorted.length,
      volumeUsd: sorted.filter((sale) => sale.currency === "USD").reduce((sum, sale) => sum + sale.salePrice, 0),
      providers,
    };
  }).sort((a, b) => new Date(b.lastSale?.saleTime ?? 0).getTime() - new Date(a.lastSale?.saleTime ?? 0).getTime());
}

function ProviderStatusPanel({ statuses, loading, error, live }: { statuses: ProviderStatus[]; loading: boolean; error?: string; live: boolean }) {
  if (loading) return <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">Loading provider status...</div>;
  if (error) return <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">Market sales endpoint failed: {error}</div>;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className={`h-2 w-2 rounded-full ${live ? "bg-success animate-pulse" : "bg-muted-foreground"}`} />
            {live ? "Live provider tracking active" : "Provider tracking ready · no live sale rows for this view"}
          </div>
          <div className="text-xs text-muted-foreground mt-1">Refresh cadence: 10 minutes · target window: 150 NFT sales per provider</div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2">
          {statuses.map((status) => <ProviderPill key={status.provider} status={status} />)}
        </div>
      </div>
    </div>
  );
}

function ProviderPill({ status }: { status: ProviderStatus }) {
  const label = providerLabels[status.provider] ?? status.provider;
  const state = status.ok ? "Live" : status.enabled ? "Configured" : "Not connected";
  const dotClass = status.ok ? "bg-success" : status.enabled ? "bg-primary" : "bg-muted-foreground";

  return (
    <span className="inline-flex min-w-[132px] items-center justify-between gap-2 rounded border border-border bg-surface px-2.5 py-1.5 text-[11px] text-muted-foreground" title={status.message}>
      <span className="inline-flex items-center gap-1.5 truncate">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
        <span className="truncate">{label}</span>
      </span>
      <span className="font-medium text-foreground">{state}</span>
    </span>
  );
}

function SaleStatus({ sale }: { sale: NormalizedSale }) {
  const hasTx = Boolean(sale.txSignature || sale.sourceUrl);
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-success/30 bg-success/10 px-2 py-1 text-[11px] text-success">
      <span className="h-1.5 w-1.5 rounded-full bg-success" />
      {hasTx ? "On-chain sale" : "Confirmed sale"}
      {sale.sourceUrl && <a href={sale.sourceUrl} target="_blank" rel="noreferrer" className="hover:text-foreground"><ExternalLink className="h-3 w-3" /></a>}
    </span>
  );
}

function AssetState({ sale, live }: { sale?: NormalizedSale; live: boolean }) {
  if (!sale) return <span className="text-xs text-muted-foreground">No sale</span>;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] ${live ? "border-success/30 bg-success/10 text-success" : "border-border bg-surface text-muted-foreground"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-success" : "bg-muted-foreground"}`} />
      {live ? "Live" : "Stored"}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold font-mono tabular-nums">{value}</div>
    </div>
  );
}

function formatSalePrice(sale: NormalizedSale): string {
  if (sale.currency === "USD") return fmtUSD(sale.salePrice);
  return `${sale.salePrice.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${sale.currency}`;
}
