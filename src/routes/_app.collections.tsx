import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Activity,
  Coins,
  Filter,
  Hand,
  LayoutGrid,
  RefreshCcw,
  Search,
  ShoppingBag,
  Tag,
  X,
} from "lucide-react";
import { categoryIcon } from "@/components/app/categoryIcons";
import { RelativeTime } from "@/components/app/RelativeTime";

export const Route = createFileRoute("/_app/collections")({
  component: MarketsPage,
  head: () => ({ meta: [{ title: "Markets — Perp RWA" }] }),
});

const AUTO_REFRESH_MS = 60_000;

type CategoryRow = {
  category: string;
  total: number;
  hold: number;
  listed: number;
  bid: number;
  makeOffer: number;
  sold: number;
  transferred: number;
  minted: number;
  unknownState: number;
};

type ApiResponse = {
  categories: CategoryRow[];
  totals: Omit<CategoryRow, "category">;
  lastCheckedAt: string | null;
  generatedAt: string;
};

const CATEGORY_DISPLAY: Record<string, { name: string; slug: string }> = {
  pokemon: { name: "Pokémon", slug: "pokemon-cards" },
  one_piece: { name: "One Piece", slug: "one-piece-cards" },
  basketball: { name: "NBA / Basketball", slug: "nba-cards" },
  football: { name: "NFL / Football", slug: "nfl-cards" },
  hockey: { name: "NHL / Hockey", slug: "nhl-cards" },
  baseball: { name: "Baseball", slug: "baseball-cards" },
  soccer: { name: "Soccer", slug: "soccer-cards" },
  yugioh: { name: "Yu-Gi-Oh", slug: "yugioh-cards" },
  dragon_ball: { name: "Dragon Ball", slug: "dragon-ball-cards" },
  magic_the_gathering: { name: "Magic The Gathering", slug: "magic-the-gathering-cards" },
  unknown: { name: "Unknown", slug: "unknown" },
};

function displayName(category: string) {
  return CATEGORY_DISPLAY[category]?.name ?? category;
}

function displaySlug(category: string) {
  return CATEGORY_DISPLAY[category]?.slug ?? category;
}

function fmt(value: number) {
  return value.toLocaleString("en-US");
}

function formatCountdown(seconds: number) {
  const safe = Math.max(0, Math.trunc(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

type SortKey = "total" | "hold" | "listed" | "bid" | "make_offer" | "name";

function MarketsPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hideEmpty, setHideEmpty] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("total");
  const [nextRefreshAt, setNextRefreshAt] = useState(() => Date.now() + AUTO_REFRESH_MS);
  const [refreshCountdownSeconds, setRefreshCountdownSeconds] = useState(() => Math.ceil(AUTO_REFRESH_MS / 1000));

  useEffect(() => {
    const controller = new AbortController();
    async function load(showLoading = true) {
      if (showLoading) setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/markets/state", {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        const payload = (await res.json()) as ApiResponse | { error?: string };
        if (!res.ok) throw new Error(("error" in payload && payload.error) || "Unable to load markets");
        setData(payload as ApiResponse);
        setNextRefreshAt(Date.now() + AUTO_REFRESH_MS);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Unable to load markets");
      } finally {
        if (showLoading) setLoading(false);
      }
    }
    void load(true);
    const refresh = window.setInterval(() => {
      setNextRefreshAt(Date.now() + AUTO_REFRESH_MS);
      void load(false);
    }, AUTO_REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(refresh);
    };
  }, []);

  useEffect(() => {
    const tick = window.setInterval(() => {
      setRefreshCountdownSeconds(Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000)));
    }, 1000);
    setRefreshCountdownSeconds(Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000)));
    return () => window.clearInterval(tick);
  }, [nextRefreshAt]);

  const visible = useMemo(() => {
    if (!data) return [];
    let rows = data.categories.slice();
    if (search.trim()) {
      const term = search.trim().toLowerCase();
      rows = rows.filter((r) => displayName(r.category).toLowerCase().includes(term) || r.category.toLowerCase().includes(term));
    }
    if (hideEmpty) {
      rows = rows.filter((r) => r.category !== "unknown");
    }
    const dir = sortKey === "name" ? 1 : -1;
    rows.sort((a, b) => {
      if (sortKey === "name") return displayName(a.category).localeCompare(displayName(b.category));
      const key = sortKey === "make_offer" ? "makeOffer" : sortKey;
      return ((a[key as keyof CategoryRow] as number) - (b[key as keyof CategoryRow] as number)) * dir;
    });
    return rows;
  }, [data, search, hideEmpty, sortKey]);

  const activeFilters: Array<{ key: string; label: string; onClear: () => void }> = [];
  if (search.trim()) activeFilters.push({ key: "s", label: `"${search.trim()}"`, onClear: () => setSearch("") });
  if (hideEmpty) activeFilters.push({ key: "h", label: "Hide 'unknown'", onClear: () => setHideEmpty(false) });

  const totals = data?.totals;
  const activeOffers = totals ? totals.bid + totals.makeOffer : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/30 text-primary">
            <LayoutGrid className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Markets</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Per-category breakdown of tracked NFTs, current state, and recent market activity.
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
        <Stat icon={<Coins className="h-4 w-4" />} label="Total NFTs tracked" value={loading || !totals ? "..." : fmt(totals.total)} accent="primary" />
        <Stat icon={<Hand className="h-4 w-4" />} label="Hold (owned)" value={loading || !totals ? "..." : fmt(totals.hold)} accent="emerald" />
        <Stat icon={<Tag className="h-4 w-4" />} label="Listed" value={loading || !totals ? "..." : fmt(totals.listed)} accent="amber" />
        <Stat icon={<Activity className="h-4 w-4" />} label="Active offers (bid + make offer)" value={loading || !totals ? "..." : fmt(activeOffers)} accent="violet" />
      </div>

      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          <span>Filters</span>
        </div>
        <div className="grid gap-3 md:grid-cols-5">
          <div className="relative md:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search market name"
              className="h-10 w-full rounded-md border border-border bg-surface pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/40 transition"
            />
          </div>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="h-10 rounded-md border border-border bg-surface px-3 text-sm focus:outline-none focus:border-primary/50"
          >
            <option value="total">Sort: Total</option>
            <option value="listed">Sort: Listed</option>
            <option value="hold">Sort: Hold</option>
            <option value="make_offer">Sort: Make offer</option>
            <option value="bid">Sort: Bid</option>
            <option value="name">Sort: Name (A-Z)</option>
          </select>
          <button
            type="button"
            onClick={() => setHideEmpty((v) => !v)}
            aria-pressed={hideEmpty}
            className={`h-10 rounded-md border px-3 text-sm flex items-center justify-between gap-3 transition ${
              hideEmpty
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border bg-surface text-muted-foreground hover:border-border/80 hover:text-foreground"
            }`}
          >
            <span>Hide unknown</span>
            <span
              className={`flex h-4 w-4 items-center justify-center rounded-sm border ${
                hideEmpty ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface-raised"
              }`}
            >
              {hideEmpty && (
                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="M3 8l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
          </button>
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
          </div>
        )}
      </div>

      {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>}

      <div className="rounded-lg border border-border bg-card overflow-hidden shadow-sm">
        <div className="border-b border-border px-5 py-3 text-sm text-muted-foreground flex items-center justify-between gap-3">
          <span>
            {loading
              ? "Loading markets..."
              : (
                <>
                  Showing <span className="font-mono tabular-nums text-foreground">{visible.length}</span> markets
                </>
              )}
          </span>
          {data?.lastCheckedAt && (
            <span className="text-xs hidden md:flex items-center gap-1.5">
              <Activity className="h-3 w-3" />
              Last DB check: <RelativeTime iso={data.lastCheckedAt} />
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
              <tr className="text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="text-left font-medium px-5 py-3 w-10">#</th>
                <th className="text-left font-medium px-5 py-3">Market</th>
                <th className="text-right font-medium px-5 py-3">Total</th>
                <th className="text-right font-medium px-5 py-3 text-emerald-400/80">Hold</th>
                <th className="text-right font-medium px-5 py-3 text-amber-400/80">Listed</th>
                <th className="text-right font-medium px-5 py-3 text-violet-400/80">Make offer</th>
                <th className="text-right font-medium px-5 py-3 text-violet-400/80">Bid</th>
                <th className="text-right font-medium px-5 py-3 text-blue-400/80">Sold</th>
                <th className="text-right font-medium px-5 py-3 text-blue-400/80">Transferred</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-border/60">
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className={i % 2 === 1 ? "bg-surface/30" : ""}>
                    <td colSpan={9} className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-md bg-muted/60 animate-pulse" />
                        <div className="h-3 w-1/4 rounded bg-muted/60 animate-pulse" />
                        <div className="ml-auto flex gap-3">
                          {Array.from({ length: 6 }).map((__, j) => (
                            <div key={j} className="h-3 w-10 rounded bg-muted/40 animate-pulse" />
                          ))}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-5 py-16">
                    <div className="flex flex-col items-center gap-2 text-center">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
                        <ShoppingBag className="h-5 w-5" />
                      </div>
                      <div className="text-sm font-medium">No markets match.</div>
                    </div>
                  </td>
                </tr>
              ) : visible.map((row, i) => {
                const icon = categoryIcon(row.category);
                return (
                  <tr key={row.category} className={`group transition-colors ${i % 2 === 1 ? "bg-surface/30" : ""} hover:bg-surface-raised/60`}>
                    <td className="px-5 py-3.5 text-muted-foreground font-mono text-xs">{i + 1}</td>
                    <td className="px-5 py-3.5">
                      <Link to="/collections/$slug" params={{ slug: displaySlug(row.category) }} className="flex items-center gap-3">
                        {icon ? (
                          <img src={icon} alt="" className="h-9 w-9 rounded-md object-contain bg-primary/10 ring-1 ring-primary/20 p-1" />
                        ) : (
                          <div className="h-9 w-9 rounded-md bg-primary/10 ring-1 ring-primary/20 flex items-center justify-center text-[10px] text-primary">
                            {row.category.slice(0, 3).toUpperCase()}
                          </div>
                        )}
                        <div>
                          <div className="font-medium group-hover:text-primary transition">{displayName(row.category)}</div>
                          <div className="text-[11px] text-muted-foreground font-mono">{row.category}</div>
                        </div>
                      </Link>
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono tabular-nums font-semibold">{fmt(row.total)}</td>
                    <NumCell value={row.hold} accent="emerald" />
                    <NumCell value={row.listed} accent="amber" />
                    <NumCell value={row.makeOffer} accent="violet" />
                    <NumCell value={row.bid} accent="violet" />
                    <NumCell value={row.sold} accent="blue" />
                    <NumCell value={row.transferred} accent="blue" />
                  </tr>
                );
              })}
            </tbody>

            {!loading && visible.length > 0 && totals && (
              <tfoot>
                <tr className="border-t border-border bg-surface/40 text-xs">
                  <td className="px-5 py-3" />
                  <td className="px-5 py-3 font-medium uppercase tracking-wider text-muted-foreground">Total</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums font-semibold">{fmt(totals.total)}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-emerald-400">{fmt(totals.hold)}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-amber-400">{fmt(totals.listed)}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-violet-400">{fmt(totals.makeOffer)}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-violet-400">{fmt(totals.bid)}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-blue-400">{fmt(totals.sold)}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-blue-400">{fmt(totals.transferred)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

const NUM_ACCENTS = {
  emerald: "text-emerald-300",
  amber: "text-amber-300",
  violet: "text-violet-300",
  blue: "text-blue-300",
  muted: "text-muted-foreground",
} as const;

function NumCell({ value, accent = "muted" }: { value: number; accent?: keyof typeof NUM_ACCENTS }) {
  return (
    <td className={`px-5 py-3.5 text-right font-mono tabular-nums ${value > 0 ? NUM_ACCENTS[accent] : "text-muted-foreground/40"}`}>
      {fmt(value)}
    </td>
  );
}

const STAT_ACCENTS = {
  primary: "bg-primary/10 ring-primary/30 text-primary",
  emerald: "bg-emerald-500/10 ring-emerald-500/30 text-emerald-400",
  amber: "bg-amber-500/10 ring-amber-500/30 text-amber-400",
  violet: "bg-violet-500/10 ring-violet-500/30 text-violet-400",
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
