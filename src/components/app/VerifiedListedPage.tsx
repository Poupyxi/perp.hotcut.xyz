import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  BadgeCheck,
  ChevronLeft,
  ChevronRight,
  Filter,
  Layers,
  RefreshCcw,
  Search,
  ShieldCheck,
  TrendingUp,
  X,
} from "lucide-react";
import { RelativeTime } from "./RelativeTime";
import { categoryIcon } from "./categoryIcons";

const AUTO_REFRESH_MS = 60_000;

type VerificationSignal = { id: string; label: string; pass: boolean };

type VerifiedListing = {
  mint: string;
  name: string | null;
  image: string | null;
  owner: string | null;
  category: string | null;
  market: string | null;
  collection: string | null;
  listedPriceSol: number | null;
  listedPriceUsd: number | null;
  listingMarketplace: string | null;
  listingUpdatedAt: string | null;
  sourceCollection: string | null;
  latestProvider: string | null;
  floorPriceSol: number | null;
  lastSalePriceSol: number | null;
  lastSalePriceUsd: number | null;
  lastSaleAt: string | null;
  metadataStatus: string | null;
  validationStatus: string | null;
  verification: { score: number; max: number; signals: VerificationSignal[] };
};

const CATEGORY_OPTIONS: Array<[string, string]> = [
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
];

const SORT_OPTIONS: Array<[string, string]> = [
  ["updated_desc", "Recently listed"],
  ["price_desc", "Price high to low"],
  ["price_asc", "Price low to high"],
];

function short(value: string | null | undefined) {
  if (!value) return "unknown";
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function fmtSol(value: number | null) {
  return typeof value === "number" ? `${value.toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL` : null;
}

function fmtUsd(value: number | null) {
  return typeof value === "number" ? `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : null;
}

function categoryLabel(category: string | null) {
  if (!category) return "Unknown";
  return CATEGORY_OPTIONS.find(([value]) => value === category)?.[1] ?? category;
}

function marketplaceLabel(value: string | null) {
  if (!value) return "Unknown";
  const cleaned = value.toLowerCase();
  if (cleaned.includes("magic")) return "Magic Eden";
  if (cleaned.includes("tensor")) return "Tensor";
  if (cleaned.includes("phygital")) return "Phygitals";
  if (cleaned.includes("collector")) return "Collector Crypt";
  return value;
}

function scoreColor(score: number, max: number) {
  const ratio = max === 0 ? 0 : score / max;
  if (ratio >= 0.8) return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  if (ratio >= 0.5) return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  return "border-red-500/40 bg-red-500/10 text-red-300";
}

function formatCountdown(seconds: number) {
  const safe = Math.max(0, Math.trunc(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
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

export function VerifiedListedPage() {
  const [listings, setListings] = useState<VerifiedListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState("updated_desc");
  const [search, setSearch] = useState("");
  const [nextRefreshAt, setNextRefreshAt] = useState(() => Date.now() + AUTO_REFRESH_MS);
  const [refreshCountdownSeconds, setRefreshCountdownSeconds] = useState(() => Math.ceil(AUTO_REFRESH_MS / 1000));

  useEffect(() => {
    setPage(1);
  }, [category, sort, search]);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      sort,
      minScore: "0",
    });
    if (category !== "all") params.set("category", category);
    return params.toString();
  }, [category, limit, page, sort]);

  useEffect(() => {
    const controller = new AbortController();
    async function load(showLoading = true) {
      if (showLoading) setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/verified-listed?${query}`, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        const payload = (await res.json()) as { listings?: VerifiedListing[]; error?: string };
        if (!res.ok) throw new Error(payload.error ?? "Unable to load listings");
        setListings(payload.listings ?? []);
        setNextRefreshAt(Date.now() + AUTO_REFRESH_MS);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Unable to load listings");
      } finally {
        if (showLoading) setLoading(false);
      }
    }
    void load(true);
    setNextRefreshAt(Date.now() + AUTO_REFRESH_MS);
    const refresh = window.setInterval(() => {
      setNextRefreshAt(Date.now() + AUTO_REFRESH_MS);
      void load(false);
    }, AUTO_REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(refresh);
    };
  }, [query]);

  useEffect(() => {
    const tick = window.setInterval(() => {
      setRefreshCountdownSeconds(Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000)));
    }, 1000);
    setRefreshCountdownSeconds(Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000)));
    return () => window.clearInterval(tick);
  }, [nextRefreshAt]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return listings;
    return listings.filter((listing) => {
      return (
        listing.name?.toLowerCase().includes(term) ||
        listing.mint.toLowerCase().includes(term) ||
        listing.owner?.toLowerCase().includes(term) ||
        listing.collection?.toLowerCase().includes(term)
      );
    });
  }, [listings, search]);

  const totalListings = filtered.length;
  const fullyVerified = filtered.filter((l) => l.verification.score === l.verification.max).length;
  const avgPriceSol = (() => {
    const withPrice = filtered.filter((l) => typeof l.listedPriceSol === "number");
    if (withPrice.length === 0) return null;
    return withPrice.reduce((sum, l) => sum + (l.listedPriceSol ?? 0), 0) / withPrice.length;
  })();
  const marketplaceBreakdown = (() => {
    const map = new Map<string, number>();
    for (const l of filtered) {
      const key = marketplaceLabel(l.listingMarketplace);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);
  })();

  const activeFilters: Array<{ key: string; label: string; onClear: () => void }> = [];
  if (category !== "all") activeFilters.push({ key: "cat", label: categoryLabel(category), onClear: () => setCategory("all") });
  if (search.trim()) activeFilters.push({ key: "search", label: `"${search.trim()}"`, onClear: () => setSearch("") });

  const totalPages = Math.max(1, Math.ceil(totalListings / limit));
  const hasNext = page < totalPages && listings.length >= limit;
  const hasPrevious = page > 1;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 ring-1 ring-emerald-500/30 text-emerald-400">
            <BadgeCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Listed NFTs</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              All NFTs currently listed for sale across tracked marketplaces. Verification score shown as informational signal.
            </p>
          </div>
        </div>
        <div className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
          <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin text-primary" : ""}`} />
          <span>
            Auto-refresh in{" "}
            <span className="font-mono tabular-nums text-foreground">{formatCountdown(refreshCountdownSeconds)}</span>
          </span>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={<Layers className="h-4 w-4" />} label="Listed NFTs" value={loading ? "..." : totalListings.toLocaleString("en-US")} accent="primary" />
        <Stat icon={<ShieldCheck className="h-4 w-4" />} label="Fully verified (5/5)" value={loading ? "..." : fullyVerified.toLocaleString("en-US")} accent="emerald" />
        <Stat
          icon={<TrendingUp className="h-4 w-4" />}
          label="Avg listed price"
          value={loading ? "..." : avgPriceSol !== null ? `${avgPriceSol.toLocaleString("en-US", { maximumFractionDigits: 3 })} SOL` : "—"}
          accent="amber"
        />
        <div className="rounded-lg border border-border bg-card p-4 group hover:border-border/80 hover:shadow-md transition">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">By marketplace</div>
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-amber-500/10 ring-1 ring-amber-500/30 text-amber-400">
              <Activity className="h-3.5 w-3.5" />
            </div>
          </div>
          <div className="mt-2 space-y-1">
            {marketplaceBreakdown.length === 0 ? (
              <div className="text-xs text-muted-foreground">No data</div>
            ) : (
              marketplaceBreakdown.map(([name, count]) => (
                <div key={name} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground truncate">{name}</span>
                  <span className="font-mono tabular-nums">{count}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          <span>Filters</span>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <div className="relative md:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, mint, owner, collection"
              className="h-10 w-full rounded-md border border-border bg-surface pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/40 transition"
            />
          </div>

          <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-10 rounded-md border border-border bg-surface px-3 text-sm focus:outline-none focus:border-primary/50">
            {CATEGORY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>

          <select value={sort} onChange={(e) => setSort(e.target.value)} className="h-10 rounded-md border border-border bg-surface px-3 text-sm focus:outline-none focus:border-primary/50">
            {SORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>

        {activeFilters.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-border/60">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground pr-1">Active</span>
            {activeFilters.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={f.onClear}
                className="group/chip inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] text-primary hover:bg-primary/20 transition"
              >
                {f.label}
                <X className="h-3 w-3 opacity-60 group-hover/chip:opacity-100" />
              </button>
            ))}
            <button
              type="button"
              onClick={() => { setCategory("all"); setSearch(""); }}
              className="ml-auto text-[11px] text-muted-foreground hover:text-foreground transition"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>}

      <div className="rounded-lg border border-border bg-card overflow-hidden shadow-sm">
        <div className="border-b border-border px-5 py-3 text-sm text-muted-foreground flex items-center justify-between gap-3">
          <span>
            {loading
              ? "Loading listings..."
              : (
                <>
                  <span className="font-mono tabular-nums text-foreground">{filtered.length.toLocaleString("en-US")}</span> NFTs currently listed
                </>
              )}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
              <tr className="text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="w-[100px] text-center font-medium px-5 py-3">Category</th>
                <th className="text-left font-medium px-5 py-3">NFT</th>
                <th className="text-right font-medium px-5 py-3">Listed Price</th>
                <th className="text-left font-medium px-5 py-3">Marketplace</th>
                <th className="w-[180px] text-center font-medium px-5 py-3">Verification</th>
                <th className="text-left font-medium px-5 py-3">Last Sale</th>
                <th className="text-right font-medium px-5 py-3">Updated</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-border/60">
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className={i % 2 === 1 ? "bg-surface/30" : ""}>
                    <td colSpan={7} className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-md bg-muted/60 animate-pulse" />
                        <div className="flex-1 space-y-2">
                          <div className="h-3 w-1/3 rounded bg-muted/60 animate-pulse" />
                          <div className="h-2.5 w-1/4 rounded bg-muted/40 animate-pulse" />
                        </div>
                        <div className="hidden md:flex gap-3">
                          <div className="h-3 w-20 rounded bg-muted/40 animate-pulse" />
                          <div className="h-3 w-24 rounded bg-muted/40 animate-pulse" />
                          <div className="h-3 w-16 rounded bg-muted/40 animate-pulse" />
                        </div>
                      </div>
                    </td>
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-16">
                    <div className="flex flex-col items-center gap-2 text-center">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
                        <ShieldCheck className="h-5 w-5" />
                      </div>
                      <div className="text-sm font-medium">No listed NFTs match these filters.</div>
                      <div className="text-xs text-muted-foreground max-w-md">
                        Only NFTs with <span className="font-mono">is_listed=1</span> from marketplace providers appear here.
                        Try clearing the category filter, or check that your providers are active.
                      </div>
                    </div>
                  </td>
                </tr>
              ) : filtered.map((row, index) => {
                const verifColor = scoreColor(row.verification.score, row.verification.max);
                const lastSale = fmtSol(row.lastSalePriceSol) ?? fmtUsd(row.lastSalePriceUsd);
                return (
                  <tr key={row.mint} className={`group transition-colors ${index % 2 === 1 ? "bg-surface/30" : ""} hover:bg-surface-raised/60`}>
                    <td className="w-[100px] px-5 py-3 text-center text-muted-foreground">
                      <div className="flex w-full items-center justify-center">
                        {categoryIcon(row.category ?? "") ? (
                          <img src={categoryIcon(row.category ?? "") ?? ""} alt={categoryLabel(row.category)} title={categoryLabel(row.category)} className="h-6 w-6 rounded-sm object-contain" />
                        ) : (
                          <span className="text-xs">{categoryLabel(row.category)}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3 min-w-[260px]">
                      <div className="flex items-center gap-3">
                        <NftImage src={row.image} name={row.name} />
                        <div className="min-w-0">
                          <div className="font-medium truncate">{row.name ?? "Unnamed NFT"}</div>
                          <div className="text-[11px] text-muted-foreground font-mono">{short(row.mint)}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right">
                      {row.listedPriceSol !== null || row.listedPriceUsd !== null ? (
                        <div>
                          <div className="font-mono font-semibold">{fmtSol(row.listedPriceSol) ?? fmtUsd(row.listedPriceUsd)}</div>
                          {row.listedPriceSol !== null && row.listedPriceUsd !== null && (
                            <div className="text-[11px] text-muted-foreground font-mono">{fmtUsd(row.listedPriceUsd)}</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">
                      {row.listingMarketplace ? (
                        <span className="inline-flex items-center gap-1.5 rounded border border-border bg-surface px-2 py-1 text-foreground">
                          {marketplaceLabel(row.listingMarketplace)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="w-[180px] px-5 py-3 text-center">
                      <div className="flex flex-col items-center gap-1.5">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${verifColor}`}
                          title={row.verification.signals.map((s) => `${s.pass ? "✓" : "✕"} ${s.label}`).join("\n")}
                        >
                          <ShieldCheck className="h-3 w-3" />
                          {row.verification.score}/{row.verification.max}
                        </span>
                        <div className="flex gap-0.5">
                          {row.verification.signals.map((s) => (
                            <span
                              key={s.id}
                              title={`${s.pass ? "✓" : "✕"} ${s.label}`}
                              className={`h-1 w-4 rounded-full transition ${s.pass ? "bg-emerald-400/80" : "bg-muted-foreground/30"}`}
                            />
                          ))}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">
                      {lastSale ? (
                        <div>
                          <div className="font-mono">{lastSale}</div>
                          {row.lastSaleAt && <div><RelativeTime iso={row.lastSaleAt} /></div>}
                        </div>
                      ) : (
                        "No sale"
                      )}
                    </td>
                    <td className="px-5 py-3 text-right text-xs text-muted-foreground">
                      {row.listingUpdatedAt ? <RelativeTime iso={row.listingUpdatedAt} /> : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="border-t border-border px-5 py-3 flex items-center justify-between gap-3 text-sm">
          <button
            type="button"
            disabled={!hasPrevious || loading}
            onClick={() => setPage((v) => Math.max(v - 1, 1))}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-muted-foreground hover:bg-surface-raised hover:text-foreground disabled:opacity-40 disabled:hover:bg-surface disabled:hover:text-muted-foreground transition"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Previous
          </button>
          <span className="text-xs text-muted-foreground">
            Page <span className="font-mono tabular-nums text-foreground">{page}</span>
          </span>
          <button
            type="button"
            disabled={!hasNext || loading}
            onClick={() => setPage((v) => v + 1)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-muted-foreground hover:bg-surface-raised hover:text-foreground disabled:opacity-40 disabled:hover:bg-surface disabled:hover:text-muted-foreground transition"
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-dashed border-border/60 bg-card/50 p-4 text-xs text-muted-foreground space-y-1">
        <div className="flex items-center gap-2 text-foreground font-medium">
          <BadgeCheck className="h-4 w-4 text-emerald-400" />
          API access
        </div>
        <p>
          The same data is exposed at <span className="font-mono text-foreground">GET /api/verified-listed</span>.
          To require authentication, set <span className="font-mono text-foreground">VERIFIED_LISTED_API_KEY</span> in the server env;
          clients then call with <span className="font-mono text-foreground">Authorization: Bearer &lt;key&gt;</span> (or
          <span className="font-mono text-foreground"> ?api_key=…</span>).
        </p>
      </div>
    </div>
  );
}

const STAT_ACCENTS = {
  primary: "bg-primary/10 ring-primary/30 text-primary",
  emerald: "bg-emerald-500/10 ring-emerald-500/30 text-emerald-400",
  amber: "bg-amber-500/10 ring-amber-500/30 text-amber-400",
} as const;

function Stat({
  label,
  value,
  icon,
  accent = "primary",
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  accent?: keyof typeof STAT_ACCENTS;
}) {
  return (
    <div className="group relative overflow-hidden rounded-lg border border-border bg-card p-5 transition hover:border-border/80 hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        {icon && (
          <div className={`flex h-7 w-7 items-center justify-center rounded-md ring-1 ${STAT_ACCENTS[accent]}`}>
            {icon}
          </div>
        )}
      </div>
      <div className="mt-2 text-2xl font-semibold font-mono tabular-nums">{value}</div>
    </div>
  );
}
