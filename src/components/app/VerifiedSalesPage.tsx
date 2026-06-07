import { useEffect, useMemo, useState } from "react";
import { RelativeTime } from "./RelativeTime";
import { categoryIcon } from "./categoryIcons";

type VerifiedSale = {
  id: string;
  mint: string;
  category: string;
  priceSol: number | null;
  priceUsd: number | null;
  paymentMint: string | null;
  paymentSymbol: string | null;
  paymentAmount: number | null;
  previousSaleAmount: number | null;
  previousSaleSymbol: string | null;
  previousSaleTxSignature: string | null;
  priceChangeAmount: number | null;
  priceChangePercent: number | null;
  priceChangeDirection: "up" | "down" | "flat" | "unknown" | null;
  marketplace: string | null;
  txSignature: string;
  buyer: string | null;
  seller: string | null;
  eventAt: string;
  source: string;
  fallbackVerified: boolean;
  isTestSale: boolean;
  name: string | null;
  image: string | null;
  collection: string | null;
  owner: string | null;
};

const CATEGORY_OPTIONS = [
  ["all", "All categories"],
  ["pokemon", "Pokémon"],
  ["one_piece", "One Piece"],
  ["basketball", "Basketball"],
  ["football", "Football"],
  ["hockey", "Hockey"],
  ["baseball", "Baseball"],
  ["soccer", "Soccer"],
  ["yugioh", "Yu-Gi-Oh"],
  ["dragon_ball", "Dragon Ball"],
  ["magic_the_gathering", "Magic The Gathering"],
] as const;

const SOURCE_OPTIONS = [
  ["all", "All sources"],
  ["helius", "Helius verified"],
  ["magiceden", "Magic Eden verified"],
  ["tensor", "Tensor verified"],
  ["discord", "Discord verified"],
  ["manual", "Manual verified"],
  ["fallback_verified", "Fallback verified"],
] as const;

function fmtSol(value: number | null) {
  return typeof value === "number" ? `${value.toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL` : "--";
}

function fmtUsd(value: number | null) {
  return typeof value === "number" ? `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "No USD conversion";
}

function short(value: string | null | undefined) {
  if (!value) return "unknown";
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function sourceLabel(source: string) {
  if (source === "helius_enhanced_tx" || source === "helius_webhook") return "Helius verified";
  if (source === "magiceden") return "Magic Eden verified";
  if (source === "tensor") return "Tensor verified";
  if (source === "manual") return "Manual verified";
  if (source === "discord") return "Discord verified";
  if (source === "fallback_verified") return "Fallback verified";
  return SOURCE_OPTIONS.find(([value]) => value === source)?.[1] ?? source;
}

function marketplaceLabel(value: string | null) {
  if (!value) return "Marketplace unknown";

  const normalized = value.toLowerCase();

  if (normalized === "magic_eden" || normalized === "magiceden") return "Magic Eden";
  if (normalized === "tensor") return "Tensor";
  if (normalized === "collector_crypt" || normalized === "collectorcrypt") return "Collector Crypt";
  if (normalized === "phygitals" || normalized === "phygital") return "Phygitals";
  if (normalized === "ebay") return "eBay";
  if (normalized === "manual") return "Manual";

  return value;
}

function marketplaceLogo(value: string | null) {
  if (!value) return null;

  const normalized = value.toLowerCase();

  if (normalized === "magic_eden" || normalized === "magiceden") return "/magiceden.png";
  if (normalized === "tensor") return "/tensor.png";
  if (normalized === "collector_crypt" || normalized === "collectorcrypt") return "/collectorcrypt.png";
  if (normalized === "phygitals" || normalized === "phygital") return "/phygitals.png";
  if (normalized === "ebay") return "/ebay.png";

  return null;
}

function categoryLabel(category: string) {
  return CATEGORY_OPTIONS.find(([value]) => value === category)?.[1] ?? category;
}

function collectionLabel(value: string | null | undefined) {
  if (!value) return "collection unknown";
  if (value === "CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf") return "Collector Crypt";
  if (value === "BSG6DyEihFFtfvxtL9mKYsvTwiZXB1rq5gARMTJC2xAM") return "Phygitals";
  if (value === "phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC") return "Phygitals";
  return value.length > 18 ? short(value) : value;
}

function NftImage({ src, name }: { src: string | null; name: string | null }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center text-[10px] text-muted-foreground">
        NFT
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={name ?? ""}
      onError={() => setFailed(true)}
      className="h-10 w-10 rounded-md object-cover bg-muted"
    />
  );
}

function isTestSale(sale: VerifiedSale) {
  return sale.isTestSale || sale.txSignature.startsWith("TEST_SIGNATURE") || (sale.source === "manual" && sale.txSignature.startsWith("TEST_SIGNATURE"));
}

function isManualSale(sale: VerifiedSale) {
  return sale.source === "manual" || sale.marketplace === "manual";
}

function primaryPrice(sale: VerifiedSale) {
  if (typeof sale.paymentAmount === "number" && sale.paymentSymbol) {
    return `${sale.paymentAmount.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${sale.paymentSymbol}`;
  }
  if (typeof sale.priceUsd === "number") return fmtUsd(sale.priceUsd);
  if (typeof sale.priceSol === "number") return fmtSol(sale.priceSol);
  return "Price unavailable";
}

function secondaryPrice(sale: VerifiedSale) {
  if (typeof sale.paymentAmount === "number" && sale.paymentSymbol === "USDC" && typeof sale.priceUsd === "number") return fmtUsd(sale.priceUsd);
  if (typeof sale.paymentAmount === "number" && sale.paymentSymbol === "SOL" && typeof sale.priceUsd !== "number") return "No USD";
  if (typeof sale.priceUsd === "number" && typeof sale.priceSol === "number") return fmtSol(sale.priceSol);
  if (typeof sale.priceSol === "number" && sale.priceUsd === null) return "No USD";
  return "";
}

function priceGrowth(sale: VerifiedSale) {
  const sameSymbol = sale.paymentSymbol && sale.previousSaleSymbol && sale.paymentSymbol === sale.previousSaleSymbol;
  if (!sameSymbol || sale.priceChangeDirection === "unknown" || typeof sale.priceChangePercent !== "number") {
  return { label: "No history", amount: "", className: "text-muted-foreground" };
}

  const sign = sale.priceChangeDirection === "up" ? "+" : sale.priceChangeDirection === "down" ? "-" : "";
  const percent = `${sign}${Math.abs(sale.priceChangePercent).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  const amount = typeof sale.priceChangeAmount === "number" && sale.paymentSymbol
    ? `${sign}${Math.abs(sale.priceChangeAmount).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${sale.paymentSymbol}`
    : "";
  const className = sale.priceChangeDirection === "up"
    ? "text-emerald-400"
    : sale.priceChangeDirection === "down"
      ? "text-red-400"
      : "text-muted-foreground";
  return { label: percent, amount, className };
}

export function VerifiedSalesPage() {
  const [sales, setSales] = useState<VerifiedSale[]>([]);
  const [total, setTotal] = useState(0);
  const [page] = useState(1);
  const [limit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState("all");
  const [marketplace, setMarketplace] = useState("");
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");
  const [minPriceSol, setMinPriceSol] = useState("");
  const [maxPriceSol, setMaxPriceSol] = useState("");
  const [minPriceUsd, setMinPriceUsd] = useState("");
  const [maxPriceUsd, setMaxPriceUsd] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [sort, setSort] = useState("newest");
  const [hideTestSales, setHideTestSales] = useState(true);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit), sort, hideTestSales: String(hideTestSales) });
    if (category !== "all") params.set("category", category);
    if (source !== "all") params.set("source", source);
    if (marketplace.trim()) params.set("marketplace", marketplace.trim());
    if (search.trim()) params.set("search", search.trim());
    if (minPriceSol.trim()) params.set("minPriceSol", minPriceSol.trim());
    if (maxPriceSol.trim()) params.set("maxPriceSol", maxPriceSol.trim());
    if (minPriceUsd.trim()) params.set("minPriceUsd", minPriceUsd.trim());
    if (maxPriceUsd.trim()) params.set("maxPriceUsd", maxPriceUsd.trim());
    if (startDate) params.set("startDate", new Date(startDate).toISOString());
    if (endDate) params.set("endDate", new Date(`${endDate}T23:59:59`).toISOString());
    return params.toString();
  }, [category, endDate, hideTestSales, limit, marketplace, maxPriceSol, maxPriceUsd, minPriceSol, minPriceUsd, page, search, sort, source, startDate]);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/verified-sales?${query}`, { signal: controller.signal, headers: { accept: "application/json" } });
        const payload = await response.json() as { sales?: VerifiedSale[]; total?: number; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Unable to load verified sales");
        setSales(payload.sales ?? []);
        setTotal(payload.total ?? 0);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Unable to load verified sales");
      } finally {
        setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [query]);

  const solVolume = sales.reduce((sum, sale) => sum + (sale.priceSol ?? 0), 0);
  const usdVolume = sales.reduce((sum, sale) => sum + (sale.priceUsd ?? 0), 0);
  const resultStart = total === 0 ? 0 : (page - 1) * limit + 1;
  const resultEnd = Math.min(page * limit, total);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Verified Sales</h1>
        <p className="text-sm text-muted-foreground mt-1">Confirmed sales from tracked RWA NFT collections.</p>
      </div>

      <div className="grid sm:grid-cols-3 gap-4">
        <Stat label="Confirmed sales" value={loading ? "..." : total.toString()} />
        <Stat label="SOL volume" value={loading ? "..." : fmtSol(solVolume)} />
        <Stat label="USD volume" value={loading ? "..." : fmtUsd(usdVolume)} />
      </div>

      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="grid md:grid-cols-4 gap-3">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, mint, tx, buyer, seller" className="h-10 rounded-md border border-border bg-surface px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
          <select value={category} onChange={(event) => setCategory(event.target.value)} className="h-10 rounded-md border border-border bg-surface px-3 text-sm">
            {CATEGORY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select value={source} onChange={(event) => setSource(event.target.value)} className="h-10 rounded-md border border-border bg-surface px-3 text-sm">
            {SOURCE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select value={sort} onChange={(event) => setSort(event.target.value)} className="h-10 rounded-md border border-border bg-surface px-3 text-sm">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="price_sol_high">SOL high to low</option>
            <option value="price_sol_low">SOL low to high</option>
            <option value="price_usd_high">USD high to low</option>
            <option value="price_usd_low">USD low to high</option>
            <option value="growth_high">Growth high to low</option>
            <option value="growth_low">Growth low to high</option>
          </select>
        </div>
        <div className="grid md:grid-cols-6 gap-3">
          <input value={marketplace} onChange={(event) => setMarketplace(event.target.value)} placeholder="All marketplaces / marketplace search" className="h-10 rounded-md border border-border bg-surface px-3 text-sm placeholder:text-muted-foreground" />
          <input value={minPriceSol} onChange={(event) => setMinPriceSol(event.target.value)} placeholder="Min SOL" inputMode="decimal" className="h-10 rounded-md border border-border bg-surface px-3 text-sm placeholder:text-muted-foreground" />
          <input value={maxPriceSol} onChange={(event) => setMaxPriceSol(event.target.value)} placeholder="Max SOL" inputMode="decimal" className="h-10 rounded-md border border-border bg-surface px-3 text-sm placeholder:text-muted-foreground" />
          <input value={minPriceUsd} onChange={(event) => setMinPriceUsd(event.target.value)} placeholder="Min USD" inputMode="decimal" className="h-10 rounded-md border border-border bg-surface px-3 text-sm placeholder:text-muted-foreground" />
          <input value={maxPriceUsd} onChange={(event) => setMaxPriceUsd(event.target.value)} placeholder="Max USD" inputMode="decimal" className="h-10 rounded-md border border-border bg-surface px-3 text-sm placeholder:text-muted-foreground" />
          <label className="h-10 rounded-md border border-border bg-surface px-3 text-sm flex items-center justify-between gap-3 text-muted-foreground">
            <span>Hide test sales</span>
            <input type="checkbox" checked={hideTestSales} onChange={(event) => setHideTestSales(event.target.checked)} className="h-4 w-4 accent-primary" />
          </label>
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="h-10 rounded-md border border-border bg-surface px-3 text-sm" />
          <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="h-10 rounded-md border border-border bg-surface px-3 text-sm" />
        </div>
      </div>

      {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>}

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-5 py-3 text-sm text-muted-foreground">
          {loading ? "Loading results..." : `Showing ${resultStart}-${resultEnd} of ${total} verified sales`}
          {hideTestSales && <span className="ml-2 text-xs">Test sales hidden</span>}
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground border-b border-border">
              <th className="text-center font-medium px-5 py-3">Category</th>              
              <th className="text-left font-medium px-5 py-3">NFT</th>
              <th className="text-right font-medium px-5 py-3">Price</th>
              <th className="text-right font-medium px-5 py-3">USD</th>
              <th className="text-center font-medium px-5 py-3">Growth</th>
              <th className="text-center font-medium px-5 py-3">Market</th>
              <th className="text-center font-medium px-5 py-3">TX</th>
              <th className="text-center font-medium px-5 py-3">Owner</th>
              <th className="text-right font-medium px-5 py-3">Sold</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading ? (
              <tr><td colSpan={9} className="px-5 py-8 text-sm text-muted-foreground">Loading verified sales...</td></tr>
            ) : sales.length === 0 ? (
              <tr><td colSpan={9} className="px-5 py-8 text-sm text-muted-foreground">No confirmed sale events yet. A sale appears here only after a tracked NFT receives a verified SALE event with a transaction signature.</td></tr>
            ) : sales.map((sale) => {
              const growth = priceGrowth(sale);
              return (
                <tr key={sale.id} className="hover:bg-surface-raised/40 transition">
                  <td className="w-[90px] px-5 py-3 text-center text-muted-foreground">
                    <div className="flex w-full items-center justify-center">
                      {categoryIcon(sale.category) ? (
                        <img src={categoryIcon(sale.category) ?? ""} alt={categoryLabel(sale.category)} title={categoryLabel(sale.category)} className="h-6 w-6 rounded-sm object-contain" />
                      ) : (
                        <span className="text-xs">{categoryLabel(sale.category)}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3 min-w-[260px]">
                    <div className="flex items-center gap-3">
                      <NftImage src={sale.image} name={sale.name} />
                      <div className="min-w-0">
                        <div className="font-medium truncate">{sale.name ?? "Unnamed NFT"}</div>
                        <div className="text-[11px] text-muted-foreground truncate">{collectionLabel(sale.collection)}</div>
                      </div>
                    </div>
                  </td>
                    <td className="px-5 py-3 text-right font-mono font-semibold tabular-nums">{primaryPrice(sale)}</td>
                    <td className="px-5 py-3 text-right font-mono tabular-nums text-muted-foreground">{secondaryPrice(sale)}</td>
                    <td className={`px-5 py-3 text-center font-mono tabular-nums ${growth.className}`}>
                    <div className="font-semibold">{growth.label}</div>
                    {growth.amount && <div className="text-[11px] opacity-80">{growth.amount}</div>}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-center">
                        {marketplaceLogo(sale.marketplace) ? (
                          <img
                            src={marketplaceLogo(sale.marketplace) ?? ""}
                            alt={marketplaceLabel(sale.marketplace)}
                            className="h-5 w-5 rounded-sm object-contain"
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {isManualSale(sale) ? "Manual" : marketplaceLabel(sale.marketplace)}
                          </span>
                        )}
                      </div>
                  </td>               
                  <td className="px-5 py-3 text-center text-xs text-muted-foreground">
                    <span className="font-mono">{sale.buyer ? sale.buyer.slice(0, 4) : "unknown"}</span>
                  </td>
                  <td className="px-5 py-3 text-right text-xs text-muted-foreground"><RelativeTime iso={sale.eventAt} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
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
