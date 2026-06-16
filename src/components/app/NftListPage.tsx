import { useEffect, useMemo, useState } from "react";
import { RelativeTime } from "./RelativeTime";
import { categoryIcon } from "./categoryIcons";
import { ScannerStatusPanel } from "./ScannerStatusPanel";

const AUTO_REFRESH_MS = 60_000;

type NftAsset = {
  mint: string;
  name: string | null;
  image: string | null;
  owner: string | null;
  collection: string | null;
  collectionName: string | null;
  sourceCollection: string | null;
  sourceProvider: string | null;
  category: string;
  assetType: string;
  publicGroup: string;
  isStaging: boolean;
  isListed: boolean;
  currentState: string;
  currentStatus: string;
  lastActivityType: string;
  lastActivityAt: string | null;
  lastActivityTxHash: string | null;
  lastActivityProvider: string | null;
  latestListingPriceSol: number | null;
  latestListingPriceUsd: number | null;
  listingMarketplace: string | null;
  lastListedAt: string | null;
  latestMarketPriceSol: number | null;
  latestMarketPriceUsd: number | null;
  latestPurchasePriceSol: number | null;
  latestPurchasePriceUsd: number | null;
  latestMarketplace: string | null;
  latestProvider: string | null;
  latestTxHash: string | null;
  lastCheckedAt: string | null;
  metadataStatus: string;
  validationStatus: string;
  updatedAt: string | null;
  lastSalePriceSol: number | null;
  lastSalePriceUsd: number | null;
  lastSaleAt: string | null;
  lastSaleMarketplace: string | null;
};

type NftListStats = {
  listedTotal: number;
  listedLast10Minutes: number;
  verifiedSalesTotal: number;
  verifiedSalesLast10Minutes: number;
  transferredTotal: number;
  transferredLast10Minutes: number;
  mintedTotal: number;
  mintedLast10Minutes: number;
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
  ["unknown", "Unknown"],
] as const;

const ASSET_TYPE_OPTIONS = [
  ["all", "All asset types"],
  ["card", "Cards"],
  ["sealed", "Sealed"],
  ["comic", "Comics"],
  ["merch", "Merch"],
  ["unknown", "Unknown"],
] as const;

const SOURCE_COLLECTION_OPTIONS = [
  ["all", "All sources"],
  ["collector_crypt", "Collector Crypt"],
  ["phygitals", "Phygitals"],
] as const;

const STATUS_OPTIONS = [
  ["all", "All statuses"],
  ["owned", "Owned"],
  ["listed", "Listed"],
  ["unlisted", "Unlisted"],
  ["sold", "Sold"],
  ["transferred_out", "Transferred out"],
  ["stale", "Stale"],
  ["unknown", "Unknown"],
] as const;

const ACTIVITY_OPTIONS = [
  ["minted", "Minted"],
  ["listed", "Listed"],
  ["delisted", "Delisted"],
  ["bought", "Bought"],
  ["sold", "Sold"],
  ["transferred", "Transferred"],
  ["pack_opened", "Pack opened"],
  ["unknown", "Unknown"],
] as const;

function sourceCollectionLabel(value: string | null | undefined) {
  if (!value) return "collection unknown";
  if (value === "CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf") return "Collector Crypt";
  if (value === "BSG6DyEihFFtfvxtL9mKYsvTwiZXB1rq5gARMTJC2xAM") return "Phygitals";
  if (value === "phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC") return "Phygitals";
  return short(value);
}

function sourceCollectionLogo(value: string | null | undefined) {
  if (value === "CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf") return "/collectorcrypt.png";
  if (value === "BSG6DyEihFFtfvxtL9mKYsvTwiZXB1rq5gARMTJC2xAM") return "/phygitals.png";
  if (value === "phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC") return "/phygitals.png";
  return null;
}

function short(value: string | null | undefined) {
  if (!value) return "unknown";
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function looksLikeMint(value: string) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim());
}

function nftFromLookupResponse(nft: Record<string, unknown>, fallbackMint: string): NftAsset {
  return {
    mint: typeof nft.assetMint === "string" ? nft.assetMint : typeof nft.mint === "string" ? nft.mint : fallbackMint,
    name: typeof nft.assetName === "string" ? nft.assetName : typeof nft.name === "string" ? nft.name : null,
    image: typeof nft.imageUrl === "string" ? nft.imageUrl : typeof nft.image === "string" ? nft.image : null,
    owner: typeof nft.ownerWallet === "string" ? nft.ownerWallet : typeof nft.owner === "string" ? nft.owner : null,
    collection: typeof nft.collectionSlug === "string" ? nft.collectionSlug : typeof nft.collection === "string" ? nft.collection : null,
    collectionName: typeof nft.collectionName === "string" ? nft.collectionName : typeof nft.collection === "string" ? nft.collection : null,
    sourceCollection: typeof nft.source === "string" ? nft.source : typeof nft.sourceCollection === "string" ? nft.sourceCollection : null,
    sourceProvider: typeof nft.provider === "string" ? nft.provider : null,
    category: typeof nft.category === "string" ? nft.category : "unknown",
    assetType: typeof nft.assetType === "string" ? nft.assetType : "unknown",
    publicGroup: typeof nft.publicGroup === "string" ? nft.publicGroup : "other",
    isStaging: false,
    isListed: nft.isListed === true || nft.currentState === "listed",
    currentState: typeof nft.currentState === "string" ? nft.currentState : "unknown",
    currentStatus: typeof nft.currentStatus === "string" ? nft.currentStatus : typeof nft.currentState === "string" ? nft.currentState : "unknown",
    lastActivityType: typeof nft.lastActivityType === "string" ? nft.lastActivityType : "unknown",
    lastActivityAt: typeof nft.lastActivityAt === "string" ? nft.lastActivityAt : null,
    lastActivityTxHash: typeof nft.lastActivityTxHash === "string" ? nft.lastActivityTxHash : null,
    lastActivityProvider: typeof nft.lastActivityProvider === "string" ? nft.lastActivityProvider : null,
    latestListingPriceSol: typeof nft.latestListingPriceSol === "number" ? nft.latestListingPriceSol : null,
    latestListingPriceUsd: typeof nft.latestListingPriceUsd === "number" ? nft.latestListingPriceUsd : null,
    listingMarketplace: typeof nft.listingMarketplace === "string" ? nft.listingMarketplace : null,
    lastListedAt: typeof nft.lastListedAt === "string" ? nft.lastListedAt : null,
    latestMarketPriceSol: typeof nft.latestMarketPriceSol === "number" ? nft.latestMarketPriceSol : null,
    latestMarketPriceUsd: typeof nft.latestMarketPriceUsd === "number" ? nft.latestMarketPriceUsd : null,
    latestPurchasePriceSol: typeof nft.latestPurchasePriceSol === "number" ? nft.latestPurchasePriceSol : null,
    latestPurchasePriceUsd: typeof nft.latestPurchasePriceUsd === "number" ? nft.latestPurchasePriceUsd : null,
    latestMarketplace: typeof nft.latestMarketplace === "string" ? nft.latestMarketplace : null,
    latestProvider: typeof nft.latestProvider === "string" ? nft.latestProvider : null,
    latestTxHash: typeof nft.latestTxHash === "string" ? nft.latestTxHash : null,
    lastCheckedAt: typeof nft.lastCheckedAt === "string" ? nft.lastCheckedAt : null,
    metadataStatus: typeof nft.metadataStatus === "string" ? nft.metadataStatus : "missing",
    validationStatus: typeof nft.validationStatus === "string" ? nft.validationStatus : "unverified",
    updatedAt: typeof nft.updatedAt === "string" ? nft.updatedAt : null,
    lastSalePriceSol: typeof nft.lastSalePriceSol === "number" ? nft.lastSalePriceSol : null,
    lastSalePriceUsd: typeof nft.lastSalePriceUsd === "number" ? nft.lastSalePriceUsd : null,
    lastSaleAt: typeof nft.lastSaleAt === "string" ? nft.lastSaleAt : null,
    lastSaleMarketplace: typeof nft.lastSaleMarketplace === "string" ? nft.lastSaleMarketplace : null,
  };
}

function categoryLabel(category: string) {
  return CATEGORY_OPTIONS.find(([value]) => value === category)?.[1] ?? category;
}

function assetTypeLabel(assetType: string) {
  return ASSET_TYPE_OPTIONS.find(([value]) => value === assetType)?.[1] ?? assetType;
}

function fmtSol(value: number | null) {
  return typeof value === "number" ? `${value.toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL` : null;
}

function fmtUsd(value: number | null) {
  return typeof value === "number" ? `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : null;
}

function fmtPrice(sol: number | null, usd: number | null) {
  return fmtSol(sol) ?? fmtUsd(usd) ?? null;
}

function ownerPrefix(value: string | null | undefined) {
  return value ? value.slice(0, 4) : null;
}

function displayWalletOwner(nft: Pick<NftAsset, "owner">) {
  return ownerPrefix(nft.owner) ?? "Unknown";
}

function currentStateValue(nft: Pick<NftAsset, "currentState" | "currentStatus" | "isListed">) {
  if (nft.currentState && nft.currentState !== "unknown") return nft.currentState;
  if (nft.currentStatus && nft.currentStatus !== "unknown") return nft.currentStatus;
  return nft.isListed ? "listed" : "unknown";
}

function isActivelyListedValue(nft: Pick<NftAsset, "currentState" | "currentStatus" | "isListed">) {
  return currentStateValue(nft) === "listed" || nft.isListed === true;
}

function renderedLatestListingLabel(nft: Pick<NftAsset, "currentState" | "currentStatus" | "isListed" | "latestListingPriceSol" | "latestListingPriceUsd">) {
  if (!isActivelyListedValue(nft)) return "Not listed";
  return fmtPrice(nft.latestListingPriceSol, nft.latestListingPriceUsd) ?? "Not listed";
}

function statusClass(value: string | null | undefined) {
  if (value === "listed") return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  if (value === "owned") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  if (value === "sold" || value === "transferred_out") return "border-red-500/40 bg-red-500/10 text-red-300";
  if (value === "stale") return "border-red-500/40 bg-red-500/10 text-red-300";
  if (value === "unlisted") return "border-border bg-surface text-muted-foreground";
  return "border-border bg-muted text-muted-foreground";
}

function activityLabel(value: string | null | undefined) {
  if (value === "pack_opened") return "Pack Opened";
  if (value === "transferred") return "Transferred";
  if (value === "listed") return "Listed";
  if (value === "delisted") return "Delisted";
  if (value === "bought") return "Buy";
  if (value === "sold") return "Sold";
  if (value === "minted") return "Minted";
  return "Unknown";
}

function activityClass(value: string | null | undefined) {
  if (value === "listed") return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  if (value === "bought" || value === "minted" || value === "pack_opened") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  if (value === "sold" || value === "transferred" || value === "delisted") return "border-blue-500/40 bg-blue-500/10 text-blue-300";
  return "border-border bg-muted text-muted-foreground";
}

function providerLabel(value: string | null | undefined) {
  if (!value) return "No provider";
  if (value === "helius_enhanced_tx" || value === "helius_webhook") return "Helius";
  if (value === "magiceden" || value === "magic-eden") return "Magic Eden";
  if (value === "collector-crypt") return "Collector Crypt";
  return value;
}

function txUrl(value: string | null | undefined) {
  if (value?.startsWith("TEST_SIGNATURE")) return null;
  return value ? `https://solscan.io/tx/${value}` : null;
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

export function NftListPage() {
  const [nfts, setNfts] = useState<NftAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<NftListStats>({
    listedTotal: 0,
    listedLast10Minutes: 0,
    verifiedSalesTotal: 0,
    verifiedSalesLast10Minutes: 0,
    transferredTotal: 0,
    transferredLast10Minutes: 0,
    mintedTotal: 0,
    mintedLast10Minutes: 0,
  });
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mintLookupLoading, setMintLookupLoading] = useState(false);
  const [mintLookupNote, setMintLookupNote] = useState<string | null>(null);
  const [nextRefreshAt, setNextRefreshAt] = useState(() => Date.now() + AUTO_REFRESH_MS);
  const [refreshCountdownSeconds, setRefreshCountdownSeconds] = useState(() => Math.ceil(AUTO_REFRESH_MS / 1000));

  const [category, setCategory] = useState("all");
  const [assetType, setAssetType] = useState("all");
  const [sourceCollection, setSourceCollection] = useState("");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("checked_desc");
  const [includeOther, setIncludeOther] = useState(false);
  const [includeUnknown, setIncludeUnknown] = useState(false);
  const [missingImage, setMissingImage] = useState(false);

  useEffect(() => {
    setPage(1);
  }, [category, assetType, sourceCollection, status, search, sort, includeOther, includeUnknown, missingImage]);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      sort,
      includeOther: String(includeOther),
      includeUnknown: String(includeUnknown),
      includeStaging: "false",
      missingImage: String(missingImage),
    });

    if (category !== "all") params.set("category", category);
    if (assetType !== "all") params.set("assetType", assetType);
    if (status !== "all") params.set("status", status);
    if (sourceCollection.trim()) params.set("sourceCollection", sourceCollection.trim());
    if (search.trim()) params.set("search", search.trim());

    return params.toString();
  }, [assetType, category, includeOther, includeUnknown, limit, missingImage, page, search, sort, sourceCollection, status]);

  useEffect(() => {
    const controller = new AbortController();

    async function load(showLoading = true) {
      if (showLoading) setLoading(true);
      setError(null);
      setMintLookupLoading(false);
      setMintLookupNote(null);

      try {
        const searchedMint = search.trim();
        const isMintSearch = looksLikeMint(searchedMint);
        const response = await fetch(`/api/nft-list?${query}`, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });

        const payload = await response.json() as ({ nfts?: NftAsset[]; total?: number; error?: string } & Partial<NftListStats>);
        if (!response.ok) throw new Error(payload.error ?? "Unable to load NFT list");

        setNfts(payload.nfts ?? []);
        setTotal(payload.total ?? 0);
        setStats({
          listedTotal: payload.listedTotal ?? 0,
          listedLast10Minutes: payload.listedLast10Minutes ?? 0,
          verifiedSalesTotal: payload.verifiedSalesTotal ?? 0,
          verifiedSalesLast10Minutes: payload.verifiedSalesLast10Minutes ?? 0,
          transferredTotal: payload.transferredTotal ?? 0,
          transferredLast10Minutes: payload.transferredLast10Minutes ?? 0,
          mintedTotal: payload.mintedTotal ?? 0,
          mintedLast10Minutes: payload.mintedLast10Minutes ?? 0,
        });

        setNextRefreshAt(Date.now() + AUTO_REFRESH_MS);

        if (isMintSearch && page === 1) {
          console.log("[NFT LIST][SEARCH] forcing on-demand refresh", {
            searchedMint,
            localMatchesCount: payload.total ?? 0,
            apiCalled: true,
          });
          setMintLookupLoading(true);
          setMintLookupNote("Fetching NFT from Helius...");
          const mintResponse = await fetch(`/api/nfts/${encodeURIComponent(searchedMint)}?refresh=true`, {
            signal: controller.signal,
            headers: { accept: "application/json" },
          });

          const mintPayload = await mintResponse.json() as { nft?: Record<string, unknown>; error?: string };
          if (mintResponse.ok && mintPayload.nft) {
            const refreshed = nftFromLookupResponse(mintPayload.nft, searchedMint);
            console.log("[NFT LIST][SEARCH] API result received", { searchedMint, currentState: refreshed.currentState, isListed: refreshed.isListed });
            setNfts([refreshed]);
            setTotal(1);
            setMintLookupNote(null);
          } else {
            console.log("[NFT LIST][SEARCH] API refresh failed", { searchedMint, error: mintPayload.error ?? "NFT not found or provider unavailable" });
            setNfts([]);
            setTotal(0);
            setMintLookupNote(mintPayload.error ?? "NFT not found or provider unavailable");
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Unable to load NFT list");
      } finally {
        setMintLookupLoading(false);
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

  const resultStart = total === 0 ? 0 : (page - 1) * limit + 1;
  const resultEnd = Math.min(page * limit, total);
  const hasNext = resultEnd < total;
  const hasPrevious = page > 1;
  const loadingLabel = mintLookupLoading ? "Fetching NFT from Helius..." : "Loading results...";

  const visibleCards = nfts.filter((nft) => nft.assetType === "card").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">NFT List</h1>
        <p className="text-sm text-muted-foreground mt-1">Tracked NFTs enriched with current status, verified sales, listings, and latest market price.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="NFTs matching filters" value={loading ? "..." : total.toLocaleString("en-US")} />
        <Stat label="Cards on page" value={loading ? "..." : visibleCards.toString()} />
        <MarketActivityCard
          loading={loading}
          stats={stats}
        />
      </div>

      <ScannerStatusPanel />

      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="grid md:grid-cols-5 gap-3">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name, mint, owner, collection"
            className="h-10 rounded-md border border-border bg-surface px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />

          <select value={category} onChange={(event) => setCategory(event.target.value)} className="h-10 rounded-md border border-border bg-surface px-3 text-sm">
            {CATEGORY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>

          <select value={assetType} onChange={(event) => setAssetType(event.target.value)} className="h-10 rounded-md border border-border bg-surface px-3 text-sm">
            {ASSET_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>

          <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-10 rounded-md border border-border bg-surface px-3 text-sm">
            {STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>

          <select value={sort} onChange={(event) => setSort(event.target.value)} className="h-10 rounded-md border border-border bg-surface px-3 text-sm">
            <option value="checked_desc">Recently checked</option>
            <option value="updated_desc">Recently updated</option>
            <option value="name_asc">Name A to Z</option>
            <option value="name_desc">Name Z to A</option>
            <option value="market_price_desc">Market price high to low</option>
            <option value="market_price_asc">Market price low to high</option>
            <option value="category_asc">Category A to Z</option>
          </select>
        </div>

        <div className="grid md:grid-cols-4 gap-3">
        <select
            value={sourceCollection || "all"}
            onChange={(event) => setSourceCollection(event.target.value === "all" ? "" : event.target.value)}
            className="h-10 rounded-md border border-border bg-surface px-3 text-sm"
            >
            {SOURCE_COLLECTION_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>))}
        </select>

          <label className="h-10 rounded-md border border-border bg-surface px-3 text-sm flex items-center justify-between gap-3 text-muted-foreground">
            <span>Include other</span>
            <input type="checkbox" checked={includeOther} onChange={(event) => setIncludeOther(event.target.checked)} className="h-4 w-4 accent-primary" />
          </label>

          <label className="h-10 rounded-md border border-border bg-surface px-3 text-sm flex items-center justify-between gap-3 text-muted-foreground">
            <span>Include unknown</span>
            <input type="checkbox" checked={includeUnknown} onChange={(event) => setIncludeUnknown(event.target.checked)} className="h-4 w-4 accent-primary" />
          </label>

          <label className="h-10 rounded-md border border-border bg-surface px-3 text-sm flex items-center justify-between gap-3 text-muted-foreground">
            <span>Missing image only</span>
            <input type="checkbox" checked={missingImage} onChange={(event) => setMissingImage(event.target.checked)} className="h-4 w-4 accent-primary" />
          </label>
        </div>
      </div>

      {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>}

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-5 py-3 text-sm text-muted-foreground flex items-center justify-between gap-3">
          <span>{loading ? loadingLabel : `Showing ${resultStart}-${resultEnd} of ${total.toLocaleString("en-US")} NFTs`}</span>
          <div className="flex items-center gap-3 text-xs">
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400/80" />
              Next update in {formatCountdown(refreshCountdownSeconds)}
            </span>
            {!includeOther && !includeUnknown && <span>Cards only · other assets hidden</span>}
          </div>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
              <th className="w-[120px] text-center font-medium px-5 py-3">Category</th>
              <th className="text-left font-medium px-5 py-3">NFT</th>
              <th className="text-center font-medium px-5 py-3">Wallet</th>
              <th className="text-left font-medium px-5 py-3">Last Activity</th>
              <th className="text-left font-medium px-5 py-3">Last Listed Price</th>
              <th className="text-left font-medium px-5 py-3">Latest Verified Sale</th>
                            <th className="text-center font-medium px-5 py-3">Asset Type</th>
              <th className="w-[90px] text-center font-medium px-5 py-3">Source</th>
              <th className="text-left font-medium px-5 py-3">Provider</th>
              <th className="text-right font-medium px-5 py-3">Last Checked</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-border">
            {loading ? (
              <tr><td colSpan={10} className="px-5 py-8 text-sm text-muted-foreground">Loading NFTs...</td></tr>
            ) : nfts.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-5 py-8 text-sm text-muted-foreground">
                  <div className="space-y-1">
                    <div>No NFTs match these filters.</div>
                    {mintLookupNote && <div className="text-xs">{mintLookupNote}</div>}
                  </div>
                </td>
              </tr>
            ) : nfts.map((nft) => {
              const latestMarketPrice = fmtPrice(nft.latestMarketPriceSol, nft.latestMarketPriceUsd);
              const lastSale = fmtPrice(nft.lastSalePriceSol, nft.lastSalePriceUsd);
              console.log("[NFT LIST][ROW]", {
                mint: nft.mint,
                ownerPrefix: ownerPrefix(nft.owner),
                latestMarketPriceSol: nft.latestMarketPriceSol,
                lastSalePriceSol: nft.lastSalePriceSol,
              });
              return (
                
                <tr key={nft.mint} className="hover:bg-surface-raised/40 transition">
                  <td className="w-[120px] px-5 py-3 text-center text-muted-foreground">
                    <div className="flex w-full items-center justify-center">
                      {categoryIcon(nft.category) ? (
                        <img src={categoryIcon(nft.category) ?? ""} alt={categoryLabel(nft.category)} title={categoryLabel(nft.category)} className="h-6 w-6 rounded-sm object-contain" />
                      ) : (
                        <span className="text-xs">{categoryLabel(nft.category)}</span>
                      )}
                    </div>
                  </td> 
                  <td className="px-5 py-3 min-w-[300px]">
                    <div className="flex items-center gap-3">
                      <NftImage src={nft.image} name={nft.name} />
                      <div className="min-w-0">
                        <div className="font-medium truncate">{nft.name ?? "Unnamed NFT"}</div>
                        <div className="text-[11px] text-muted-foreground font-mono">{short(nft.mint)}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-center">
                    <span className="rounded border border-border bg-surface px-2 py-1 text-xs text-foreground">
                      {displayWalletOwner({ owner: nft.owner })}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-xs text-muted-foreground">
                    <div className="flex flex-col gap-1">
                      <span className={`w-fit rounded border px-2 py-1 text-xs ${activityClass(nft.lastActivityType)}`}>
                        {activityLabel(nft.lastActivityType)}
                      </span>
                      {nft.lastActivityAt ? <span><RelativeTime iso={nft.lastActivityAt} /></span> : <span>Not detected</span>}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-xs">
                    {latestMarketPrice ? (
                      <div>
                        <div className="font-mono font-semibold">{latestMarketPrice}</div>
                        <div className="text-muted-foreground">Sales first</div>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">Unknown</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-xs text-muted-foreground">
                    {lastSale ? (
                      <div>
                        <div className="font-mono">{lastSale}</div>
                        {nft.lastSaleAt && <div><RelativeTime iso={nft.lastSaleAt} /></div>}
                      </div>
                    ) : (
                      "No verified sale"
                    )}
                  </td>
                  <td className="px-5 py-3 text-center">
                    <span className="rounded border border-border bg-surface px-2 py-1 text-xs text-muted-foreground">
                      {assetTypeLabel(nft.assetType)}
                    </span>
                  </td>
                  <td className="w-[90px] px-5 py-3 text-center text-xs text-muted-foreground">
                    <div className="flex w-full items-center justify-center">
                      {sourceCollectionLogo(nft.sourceCollection) ? (
                        <img
                          src={sourceCollectionLogo(nft.sourceCollection) ?? ""}
                          alt={sourceCollectionLabel(nft.sourceCollection)}
                          title={sourceCollectionLabel(nft.sourceCollection)}
                          className="h-6 w-6 rounded-sm object-contain"
                        />
                      ) : (
                        <span>{sourceCollectionLabel(nft.sourceCollection)}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-xs text-muted-foreground">
                    <div>{providerLabel(nft.latestProvider ?? nft.lastActivityProvider ?? nft.sourceProvider)}</div>
                    {nft.latestTxHash && txUrl(nft.latestTxHash) ? (
                      <a className="font-mono text-primary hover:underline" href={txUrl(nft.latestTxHash) ?? undefined} target="_blank" rel="noreferrer">
                        {short(nft.latestTxHash)}
                      </a>
                    ) : nft.latestTxHash ? (
                      <div className="font-mono">{short(nft.latestTxHash)}</div>
                    ) : null}
                  </td>
                  <td className="px-5 py-3 text-right text-xs text-muted-foreground">
                    {nft.lastCheckedAt ? <RelativeTime iso={nft.lastCheckedAt} /> : "Not checked"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="border-t border-border px-5 py-3 flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <button
            type="button"
            disabled={!hasPrevious || loading}
            onClick={() => setPage((value) => Math.max(value - 1, 1))}
            className="rounded-md border border-border bg-surface px-3 py-1.5 disabled:opacity-40"
          >
            Previous
          </button>

          <span>Page {page}</span>

          <button
            type="button"
            disabled={!hasNext || loading}
            onClick={() => setPage((value) => value + 1)}
            className="rounded-md border border-border bg-surface px-3 py-1.5 disabled:opacity-40"
          >
            Next
          </button>
        </div>
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

function MarketActivityCard({ loading, stats }: { loading: boolean; stats: NftListStats }) {
  const rows = [
    {
      label: "Listed",
      total: stats.listedTotal,
      recent: stats.listedLast10Minutes,
      toneClass: activityClass("listed"),
    },
    {
      label: "Verified Sales",
      total: stats.verifiedSalesTotal,
      recent: stats.verifiedSalesLast10Minutes,
      toneClass: activityClass("sold"),
    },
    {
      label: "Transferred",
      total: stats.transferredTotal,
      recent: stats.transferredLast10Minutes,
      toneClass: activityClass("transferred"),
    },
    {
      label: "Minted",
      total: stats.mintedTotal,
      recent: stats.mintedLast10Minutes,
      toneClass: activityClass("minted"),
    },
  ];

  return (
    <div className="rounded-lg border border-border bg-card p-5 sm:col-span-2">
      <div className="flex items-start justify-between gap-3">
        <div className="text-xs text-muted-foreground">Market & NFT Activity</div>
        <div className="text-xs text-muted-foreground">Last 10 minutes</div>
      </div>

      <div className="mt-4 divide-y divide-border/60">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 py-3 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <span className={`inline-flex rounded border px-2 py-1 text-xs ${row.toneClass}`}>
                {row.label}
              </span>
            </div>
            <div className="text-right text-lg font-semibold font-mono tabular-nums">
              {loading ? "..." : row.total.toLocaleString("en-US")}
            </div>
            <div className="text-right text-sm text-muted-foreground font-mono tabular-nums min-w-[2ch]">
              {loading ? "..." : row.recent.toLocaleString("en-US")}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
