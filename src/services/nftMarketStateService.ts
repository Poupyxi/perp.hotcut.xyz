import type { NFTMarketState, NFTMarketStatus, NFTMarketValidationStatus } from "@/types/rwaNftMarket";
import { ALLOWED_RWA_NFT_CATEGORIES } from "./nftCategoryService";
import { getNftDb, parseJson, stringifyJson } from "./nftSqliteDb";
import { getMarketActivityProviderStatusReport } from "./nftMarketActivityConnectors";

type SqlRow = Record<string, unknown>;

export type NFTMarketStateFilters = {
  page?: number;
  limit?: number;
  search?: string | null;
  market?: string | null;
  category?: string | null;
  status?: string | null;
  provider?: string | null;
  hasSale?: boolean | null;
  listedOnly?: boolean;
  soldOnly?: boolean;
  includeOther?: boolean;
  includeUnknown?: boolean;
  includeStaging?: boolean;
  sort?: string | null;
};

export type NFTMarketStateRefreshOptions = {
  mint?: string | null;
  limit?: number | null;
};

export type NFTMarketStateRefreshResult = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  nftsChecked: number;
  listingsFound: number;
  salesFound: number;
  verifiedSalesUpdated: number;
  errors: Array<{ mint: string; error: string }>;
  providerStatus: ReturnType<typeof getMarketActivityProviderStatusReport>["marketActivityProviders"];
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBool(value: unknown): boolean {
  return Boolean(value);
}

function cleanLimit(value: number | undefined, fallback = 50) {
  return Math.min(Math.max(Math.trunc(value ?? fallback), 1), 200);
}

function cleanPage(value: number | undefined) {
  return Math.max(Math.trunc(value ?? 1), 1);
}

function isRecent(iso: string | null, windowMs = 24 * 60 * 60 * 1000) {
  if (!iso) return false;
  const time = Date.parse(iso);
  return Number.isFinite(time) && Date.now() - time <= windowMs;
}

function isAfter(left: string | null, right: string | null) {
  if (!left) return false;
  if (!right) return true;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime > rightTime;
}

function latestSaleForMint(mint: string): SqlRow | null {
  const row = getNftDb().prepare(`
    SELECT *
    FROM rwa_nft_events
    WHERE mint = ? AND event_type = 'SALE' AND tx_signature IS NOT NULL
    ORDER BY event_at DESC
    LIMIT 1
  `).get(mint) as SqlRow | undefined;
  return row ?? null;
}

function deriveStatus(asset: SqlRow, latestSale: SqlRow | null): NFTMarketStatus {
  const isListed = asBool(asset.is_listed);
  const listingUpdatedAt = asString(asset.listing_updated_at);
  const lastSaleAt = asString(latestSale?.event_at) ?? asString(asset.last_sale_at);
  const lastCheckedAt = asString(asset.last_checked_at);

  if (isListed && isAfter(listingUpdatedAt, lastSaleAt)) return "listed";
  if (lastSaleAt && isRecent(lastSaleAt)) return "recently_sold";
  if (lastSaleAt) return "sold";
  if (isListed) return "listed";
  if (lastCheckedAt && !isRecent(lastCheckedAt)) return "stale";
  if (lastCheckedAt) return "unlisted";
  return "unknown";
}

function stateFromRows(asset: SqlRow, latestSale: SqlRow | null): NFTMarketState {
  const currentStatus = (asString(asset.current_status) as NFTMarketStatus | null) ?? deriveStatus(asset, latestSale);
  const lastSalePriceSol = asNumber(latestSale?.price_sol) ?? asNumber(asset.last_sale_price_sol);
  const lastSalePriceUsd = asNumber(latestSale?.price_usd) ?? asNumber(asset.last_sale_price_usd);
  const listingPriceSol = asNumber(asset.listed_price_sol);
  const listingPriceUsd = asNumber(asset.listed_price_usd);
  const latestPurchasePriceSol = asNumber(asset.latest_purchase_price_sol) ?? lastSalePriceSol;
  const latestPurchasePriceUsd = asNumber(asset.latest_purchase_price_usd) ?? lastSalePriceUsd;
  const latestMarketPriceSol = asNumber(asset.latest_market_price_sol) ?? lastSalePriceSol ?? latestPurchasePriceSol ?? listingPriceSol;
  const latestMarketPriceUsd = asNumber(asset.latest_market_price_usd) ?? lastSalePriceUsd ?? latestPurchasePriceUsd ?? listingPriceUsd;
  const latestMarketplace = asString(asset.latest_marketplace) ?? asString(latestSale?.marketplace) ?? asString(asset.listing_marketplace);
  const latestProvider = asString(asset.latest_provider) ?? asString(latestSale?.source);
  const latestTxHash = asString(asset.latest_tx_hash) ?? asString(latestSale?.tx_signature) ?? asString(asset.last_sale_tx_signature);

  return {
    nftId: asString(asset.id) ?? asString(asset.mint) ?? "",
    assetMint: asString(asset.mint) ?? "",
    assetName: asString(asset.name),
    market: asString(asset.category) ?? asString(asset.market),
    collectionSlug: asString(asset.source_collection) ?? asString(asset.collection),
    imageUrl: asString(asset.image),
    currentStatus,
    isListed: asBool(asset.is_listed),
    isSold: Boolean(lastSalePriceSol !== null || lastSalePriceUsd !== null || latestTxHash),
    latestListingPriceSol: listingPriceSol,
    latestListingPriceUsd: listingPriceUsd,
    latestSalePriceSol: lastSalePriceSol,
    latestSalePriceUsd: lastSalePriceUsd,
    latestPurchasePriceSol,
    latestPurchasePriceUsd,
    latestMarketPriceSol,
    latestMarketPriceUsd,
    latestMarketplace,
    latestProvider,
    latestTxHash,
    buyerWallet: asString(latestSale?.buyer),
    sellerWallet: asString(latestSale?.seller),
    lastListedAt: asString(asset.listing_updated_at),
    lastSoldAt: asString(latestSale?.event_at) ?? asString(asset.last_sale_at),
    lastCheckedAt: asString(asset.last_checked_at),
    validationStatus: ((asString(asset.validation_status) as NFTMarketValidationStatus | null) ?? (latestTxHash ? "verified" : "unverified")),
    rawPayload: parseJson(asset.raw_market_state_json, null),
  };
}

function marketStateUpdateFromRows(asset: SqlRow, latestSale: SqlRow | null) {
  const state = stateFromRows(asset, latestSale);
  const now = new Date().toISOString();
  const hasVerifiedSale = Boolean(state.latestTxHash);
  return {
    state: {
      ...state,
      lastCheckedAt: now,
      validationStatus: hasVerifiedSale ? "verified" as const : "unverified" as const,
    },
    now,
  };
}

export async function refreshNFTMarketStateForMint(mint: string): Promise<NFTMarketState | null> {
  const db = getNftDb();
  const asset = db.prepare("SELECT * FROM nft_assets WHERE mint = ?").get(mint) as SqlRow | undefined;
  if (!asset) return null;

  const latestSale = latestSaleForMint(mint);
  const { state, now } = marketStateUpdateFromRows(asset, latestSale);

  db.prepare(`
    UPDATE nft_assets SET
      current_status = ?,
      latest_market_price_sol = ?,
      latest_market_price_usd = ?,
      latest_purchase_price_sol = ?,
      latest_purchase_price_usd = ?,
      latest_marketplace = ?,
      latest_provider = ?,
      latest_tx_hash = ?,
      last_checked_at = ?,
      validation_status = ?,
      raw_market_state_json = ?,
      market_updated_at = ?,
      updated_at = ?
    WHERE mint = ?
  `).run(
    state.currentStatus,
    state.latestMarketPriceSol,
    state.latestMarketPriceUsd,
    state.latestPurchasePriceSol,
    state.latestPurchasePriceUsd,
    state.latestMarketplace,
    state.latestProvider,
    state.latestTxHash,
    now,
    state.validationStatus,
    stringifyJson({
      latestMarketPricePriority: state.latestSalePriceSol !== null || state.latestSalePriceUsd !== null
        ? "verified_sale"
        : state.latestPurchasePriceSol !== null || state.latestPurchasePriceUsd !== null
          ? "purchase"
          : state.latestListingPriceSol !== null || state.latestListingPriceUsd !== null
            ? "listing_context"
            : "unknown",
    }),
    now,
    now,
    mint,
  );

  return { ...state, lastCheckedAt: now };
}

export async function updateNFTMarketStates(options: NFTMarketStateRefreshOptions = {}): Promise<NFTMarketStateRefreshResult> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const db = getNftDb();
  const params: unknown[] = [];
  let sql = "SELECT mint FROM nft_assets";

  if (options.mint) {
    sql += " WHERE mint = ?";
    params.push(options.mint);
  }

  sql += " ORDER BY last_sale_tx_signature IS NOT NULL DESC, last_checked_at IS NULL DESC, last_checked_at ASC, updated_at DESC";
  const batchLimit = options.mint ? null : Math.trunc(options.limit ?? 1000);
  if (batchLimit && batchLimit > 0) {
    sql += " LIMIT ?";
    params.push(batchLimit);
  }

  const rows = db.prepare(sql).all(...params) as Array<{ mint: string }>;
  const errors: NFTMarketStateRefreshResult["errors"] = [];
  let listingsFound = 0;
  let salesFound = 0;
  let verifiedSalesUpdated = 0;

  for (const row of rows) {
    try {
      const state = await refreshNFTMarketStateForMint(row.mint);
      if (!state) continue;
      if (state.isListed) listingsFound += 1;
      if (state.isSold) salesFound += 1;
      if (state.validationStatus === "verified") verifiedSalesUpdated += 1;
    } catch (error) {
      errors.push({ mint: row.mint, error: error instanceof Error ? error.message : "Unknown market-state refresh error" });
    }
  }

  const finishedAt = new Date().toISOString();
  return {
    startedAt,
    finishedAt,
    durationMs: Date.now() - startMs,
    nftsChecked: rows.length,
    listingsFound,
    salesFound,
    verifiedSalesUpdated,
    errors,
    providerStatus: getMarketActivityProviderStatusReport().marketActivityProviders,
  };
}

export async function getNFTMarketState(assetMint: string) {
  const asset = getNftDb().prepare("SELECT * FROM nft_assets WHERE mint = ?").get(assetMint) as SqlRow | undefined;
  if (!asset) return null;
  return stateFromRows(asset, latestSaleForMint(assetMint));
}

export async function getNFTMarketStates(filters: NFTMarketStateFilters = {}) {
  const limit = cleanLimit(filters.limit);
  const page = cleanPage(filters.page);
  const where: string[] = ["1 = 1"];
  const params: unknown[] = [];

  if (!filters.includeStaging) where.push("is_staging = 0");
  if (!filters.includeOther) {
    where.push("asset_type = 'card'");
    where.push("public_group = 'card'");
  }
  if (!filters.includeUnknown) {
    where.push("category IS NOT NULL");
    where.push("category != 'unknown'");
    where.push(`category IN (${ALLOWED_RWA_NFT_CATEGORIES.map(() => "?").join(", ")})`);
    params.push(...ALLOWED_RWA_NFT_CATEGORIES);
  }
  const category = filters.category ?? filters.market;
  if (category && category !== "all") {
    where.push("category = ?");
    params.push(category);
  }
  if (filters.status && filters.status !== "all") {
    where.push("COALESCE(current_status, 'unknown') = ?");
    params.push(filters.status);
  }
  if (filters.provider && filters.provider !== "all") {
    where.push("(latest_provider LIKE ? OR latest_marketplace LIKE ? OR last_sale_marketplace LIKE ? OR listing_marketplace LIKE ?)");
    const needle = `%${filters.provider}%`;
    params.push(needle, needle, needle, needle);
  }
  if (filters.hasSale === true || filters.soldOnly) where.push("last_sale_tx_signature IS NOT NULL");
  if (filters.hasSale === false) where.push("last_sale_tx_signature IS NULL");
  if (filters.listedOnly) where.push("is_listed = 1");
  if (filters.search) {
    where.push(`(
      name LIKE ?
      OR mint LIKE ?
      OR owner LIKE ?
      OR collection LIKE ?
      OR source_collection LIKE ?
      OR last_sale_tx_signature LIKE ?
    )`);
    const needle = `%${filters.search}%`;
    params.push(needle, needle, needle, needle, needle, needle);
  }

  const whereSql = where.join(" AND ");
  const order = filters.sort === "checked_desc"
    ? "last_checked_at IS NULL ASC, last_checked_at DESC"
    : filters.sort === "sale_desc"
      ? "last_sale_at IS NULL ASC, last_sale_at DESC"
      : filters.sort === "market_price_desc"
        ? "latest_market_price_usd IS NULL ASC, latest_market_price_usd DESC, latest_market_price_sol DESC"
        : filters.sort === "market_price_asc"
          ? "latest_market_price_usd IS NULL ASC, latest_market_price_usd ASC, latest_market_price_sol ASC"
          : "LOWER(COALESCE(name, '')) ASC";

  const totalRow = getNftDb().prepare(`SELECT COUNT(*) AS count FROM nft_assets WHERE ${whereSql}`).get(...params) as { count?: number };
  const rows = getNftDb().prepare(`
    SELECT *
    FROM nft_assets
    WHERE ${whereSql}
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit) as SqlRow[];

  return {
    page,
    limit,
    total: Number(totalRow?.count ?? 0),
    nfts: rows.map((asset) => stateFromRows(asset, latestSaleForMint(String(asset.mint)))),
  };
}

export function currentStatusFromAssetRow(row: SqlRow): NFTMarketStatus {
  return deriveStatus(row, null);
}
