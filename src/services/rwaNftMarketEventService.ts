import { randomUUID } from "node:crypto";
import type { RwaNftMarketEvent, RwaNftMarketEventSource, RwaNftMarketEventType, VerifiedSale } from "@/types/rwaNftMarket";
import { ALLOWED_RWA_NFT_CATEGORIES, isAllowedRwaNftCategory } from "./nftCategoryService";
import { getNftDb, parseJson, sqliteBool, stringifyJson } from "./nftSqliteDb";

export type MarketEventFilters = {
  category?: string | null;
  eventType?: RwaNftMarketEventType | null;
  marketplace?: string | null;
  source?: RwaNftMarketEventSource | string | null;
  minPriceSol?: number | null;
  maxPriceSol?: number | null;
  minPriceUsd?: number | null;
  maxPriceUsd?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  search?: string | null;
  hideTestSales?: boolean;
  status?: string | null;
  provider?: string | null;
  hasSale?: boolean | null;
  listedOnly?: boolean;
  soldOnly?: boolean;
  page?: number;
  limit?: number;
  sort?: string | null;
  includeStaging?: boolean;
};

type AssetForEvent = {
  mint: string;
  category: string | null;
  is_staging: number;
  is_listed: number;
  listed_price_sol: number | null;
  listing_marketplace: string | null;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isTestSignature(value: string | null | undefined) {
  return Boolean(value?.startsWith("TEST_SIGNATURE"));
}

function inferFallbackVerified(rawPayload: unknown) {
  const payload = rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload) ? rawPayload as Record<string, unknown> : {};
  const metadata = payload._perpRwa && typeof payload._perpRwa === "object" && !Array.isArray(payload._perpRwa)
    ? payload._perpRwa as Record<string, unknown>
    : {};
  if (metadata.fallbackVerified === true) return true;
  return String(payload.type ?? payload.transactionType ?? "").toUpperCase() === "UNKNOWN" && metadata.fallbackVerified === true;
}

function cleanLimit(value: number | undefined, fallback = 50) {
  return Math.min(Math.max(Math.trunc(value ?? fallback), 1), 200);
}

function cleanPage(value: number | undefined) {
  return Math.max(Math.trunc(value ?? 1), 1);
}

function eventId(event: RwaNftMarketEvent) {
  return event.txSignature
    ? `${event.eventType.toLowerCase()}-${event.txSignature}`.toLowerCase()
    : randomUUID();
}

function loadAsset(mint: string): AssetForEvent | null {
  const row = getNftDb().prepare("SELECT mint, category, is_staging, is_listed, listed_price_sol, listing_marketplace FROM nft_assets WHERE mint = ?").get(mint);
  return row ? row as AssetForEvent : null;
}

export async function dedupeMarketEvent(event: RwaNftMarketEvent): Promise<boolean> {
  const database = getNftDb();
  if (event.txSignature) {
    const existing = database.prepare("SELECT id FROM rwa_nft_events WHERE tx_signature = ? AND event_type = ? LIMIT 1").get(event.txSignature, event.eventType);
    return Boolean(existing);
  }

  const existing = database.prepare(`
    SELECT id FROM rwa_nft_events
    WHERE mint = ? AND event_type = ? AND event_at = ? AND COALESCE(price_sol, -1) = COALESCE(?, -1) AND COALESCE(marketplace, '') = COALESCE(?, '')
    LIMIT 1
  `).get(event.mint, event.eventType, event.eventAt, event.priceSol, event.marketplace);
  return Boolean(existing);
}

export async function updateNftAssetFromMarketEvent(event: RwaNftMarketEvent): Promise<void> {
  const database = getNftDb();
  const timestamp = new Date().toISOString();

  if (event.eventType === "SALE") {
    database.prepare(`
      UPDATE nft_assets SET
        is_listed = 0,
        listed_price_sol = NULL,
        listed_price_usd = NULL,
        listing_marketplace = NULL,
        last_sale_price_sol = ?,
        last_sale_price_usd = ?,
        last_sale_at = ?,
        last_sale_marketplace = ?,
        last_sale_tx_signature = ?,
        current_status = 'recently_sold',
        latest_market_price_sol = ?,
        latest_market_price_usd = ?,
        latest_purchase_price_sol = ?,
        latest_purchase_price_usd = ?,
        latest_marketplace = ?,
        latest_provider = ?,
        latest_tx_hash = ?,
        validation_status = 'verified',
        owner = COALESCE(?, owner),
        market_updated_at = ?
      WHERE mint = ?
    `).run(
      event.priceSol,
      event.priceUsd,
      event.eventAt,
      event.marketplace,
      event.txSignature,
      event.priceSol,
      event.priceUsd,
      event.priceSol,
      event.priceUsd,
      event.marketplace,
      event.source,
      event.txSignature,
      event.owner,
      timestamp,
      event.mint,
    );
    return;
  }

  if (event.eventType === "LISTED") {
    database.prepare(`
      UPDATE nft_assets SET
        is_listed = 1,
        listed_price_sol = ?,
        listed_price_usd = ?,
        listing_marketplace = ?,
        listing_updated_at = ?,
        current_status = 'listed',
        latest_market_price_sol = COALESCE(latest_market_price_sol, ?),
        latest_market_price_usd = COALESCE(latest_market_price_usd, ?),
        latest_marketplace = COALESCE(latest_marketplace, ?),
        market_updated_at = ?
      WHERE mint = ?
    `).run(event.priceSol, event.priceUsd, event.marketplace, event.eventAt, event.priceSol, event.priceUsd, event.marketplace, timestamp, event.mint);
    return;
  }

  if (event.eventType === "DELISTED") {
    database.prepare(`
      UPDATE nft_assets SET
        is_listed = 0,
        listed_price_sol = NULL,
        listed_price_usd = NULL,
        listing_marketplace = NULL,
        current_status = CASE WHEN last_sale_tx_signature IS NOT NULL THEN current_status ELSE 'unlisted' END,
        market_updated_at = ?
      WHERE mint = ?
    `).run(timestamp, event.mint);
    return;
  }

  if (event.eventType === "PRICE_UPDATED") {
    database.prepare(`
      UPDATE nft_assets SET
        listed_price_sol = ?,
        listed_price_usd = ?,
        listing_marketplace = COALESCE(?, listing_marketplace),
        listing_updated_at = ?,
        current_status = 'listed',
        latest_market_price_sol = COALESCE(latest_market_price_sol, ?),
        latest_market_price_usd = COALESCE(latest_market_price_usd, ?),
        latest_marketplace = COALESCE(latest_marketplace, ?),
        market_updated_at = ?
      WHERE mint = ?
    `).run(event.priceSol, event.priceUsd, event.marketplace, event.eventAt, event.priceSol, event.priceUsd, event.marketplace, timestamp, event.mint);
    return;
  }

  database.prepare(`
    UPDATE nft_assets SET
      owner = COALESCE(?, owner),
      market_updated_at = ?
    WHERE mint = ?
  `).run(event.owner, timestamp, event.mint);
}

export async function saveRwaNftMarketEvent(event: RwaNftMarketEvent, options: { includeStaging?: boolean } = {}) {
  const asset = loadAsset(event.mint);
  if (!asset) return { saved: false, reason: "asset_not_tracked" };

  const category = event.category ?? asset.category;
  if (!isAllowedRwaNftCategory(category)) return { saved: false, reason: "category_not_allowed" };
  if (asset.is_staging && !options.includeStaging) return { saved: false, reason: "staging_hidden" };
  if (await dedupeMarketEvent(event)) {
    console.log("[RWA MARKET] Duplicate event skipped");
    return { saved: false, reason: "duplicate" };
  }

  const timestamp = new Date().toISOString();
  try {
    getNftDb().prepare(`
      INSERT INTO rwa_nft_events (
        id, mint, category, event_type, price_sol, price_usd, payment_mint, payment_symbol, payment_amount, marketplace, tx_signature,
        buyer, seller, owner, event_at, source, raw_payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId(event),
      event.mint,
      category,
      event.eventType,
      event.priceSol,
      event.priceUsd,
      event.paymentMint ?? null,
      event.paymentSymbol ?? null,
      event.paymentAmount ?? null,
      event.marketplace,
      event.txSignature,
      event.buyer,
      event.seller,
      event.owner,
      event.eventAt,
      event.source,
      stringifyJson(event.rawPayload),
      timestamp,
    );
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      console.log("[RWA MARKET] Duplicate event skipped");
      return { saved: false, reason: "duplicate" };
    }
    throw error;
  }

  await updateNftAssetFromMarketEvent({ ...event, category });
  console.log(`[RWA MARKET] Saved ${event.eventType} event: ${event.mint}`);
  if (event.eventType === "SALE") {
    console.log("[RWA MARKET] Verified sale saved");
    console.log("[RWA MARKET] Verified sale visible on Verified Sales page");
  }
  return { saved: true, reason: "saved" };
}

export async function getLatestEvents(filters: MarketEventFilters = {}) {
  const limit = cleanLimit(filters.limit);
  const page = cleanPage(filters.page);
  const where: string[] = ["1=1"];
  const params: unknown[] = [];

  if (filters.eventType) {
    where.push("events.event_type = ?");
    params.push(filters.eventType);
  }
  if (filters.category && filters.category !== "all") {
    where.push("events.category = ?");
    params.push(filters.category);
  }
  if (!filters.includeStaging) where.push("assets.is_staging = 0");

  params.push(limit, (page - 1) * limit);
  return getNftDb().prepare(`
    SELECT events.*, assets.name, assets.image, assets.collection, assets.owner, assets.last_sale_price_sol, assets.last_sale_at, assets.last_sale_marketplace
    FROM rwa_nft_events events
    JOIN nft_assets assets ON assets.mint = events.mint
    WHERE ${where.join(" AND ")}
    ORDER BY events.event_at DESC
    LIMIT ? OFFSET ?
  `).all(...params);
}

export async function getVerifiedSales(filters: MarketEventFilters = {}): Promise<{ sales: VerifiedSale[]; page: number; limit: number; total: number }> {
  const limit = cleanLimit(filters.limit);
  const page = cleanPage(filters.page);
  const where: string[] = [
    "events.event_type = 'SALE'",
    "events.tx_signature IS NOT NULL",
    "events.category IS NOT NULL",
    "events.category != 'unknown'",
    `events.category IN (${ALLOWED_RWA_NFT_CATEGORIES.map(() => "?").join(", ")})`,
  ];
  const params: unknown[] = [...ALLOWED_RWA_NFT_CATEGORIES];

  if (!filters.includeStaging) where.push("assets.is_staging = 0");
  if (filters.category && filters.category !== "all") {
    where.push("events.category = ?");
    params.push(filters.category);
  }
  if (filters.marketplace && filters.marketplace !== "all") {
    where.push("events.marketplace LIKE ?");
    params.push(`%${filters.marketplace}%`);
  }
  if (filters.source && filters.source !== "all") {
    if (filters.source === "helius") {
      where.push("events.source IN ('helius_enhanced_tx', 'helius_webhook')");
    } else if (filters.source === "fallback_verified") {
      where.push("events.raw_payload_json LIKE ?");
      params.push('%"fallbackVerified":true%');
    } else {
      where.push("events.source = ?");
      params.push(filters.source);
    }
  }
  if (typeof filters.minPriceSol === "number") {
    where.push("events.price_sol >= ?");
    params.push(filters.minPriceSol);
  }
  if (typeof filters.maxPriceSol === "number") {
    where.push("events.price_sol <= ?");
    params.push(filters.maxPriceSol);
  }
  if (typeof filters.minPriceUsd === "number") {
    where.push("events.price_usd >= ?");
    params.push(filters.minPriceUsd);
  }
  if (typeof filters.maxPriceUsd === "number") {
    where.push("events.price_usd <= ?");
    params.push(filters.maxPriceUsd);
  }
  if (filters.startDate) {
    where.push("events.event_at >= ?");
    params.push(filters.startDate);
  }
  if (filters.endDate) {
    where.push("events.event_at <= ?");
    params.push(filters.endDate);
  }
  if (filters.search) {
    where.push(`(
      assets.name LIKE ?
      OR events.mint LIKE ?
      OR events.tx_signature LIKE ?
      OR events.buyer LIKE ?
      OR events.seller LIKE ?
      OR assets.collection LIKE ?
      OR events.marketplace LIKE ?
    )`);
    const needle = `%${filters.search}%`;
    params.push(needle, needle, needle, needle, needle, needle, needle);
  }
  if (filters.hideTestSales ?? true) {
    where.push("events.tx_signature NOT LIKE 'TEST_SIGNATURE%'");
  }
  if (filters.status && filters.status !== "all") {
    where.push("COALESCE(assets.current_status, 'unknown') = ?");
    params.push(filters.status);
  }
  if (filters.provider && filters.provider !== "all") {
    where.push("(events.source LIKE ? OR assets.latest_provider LIKE ? OR assets.latest_marketplace LIKE ?)");
    const needle = `%${filters.provider}%`;
    params.push(needle, needle, needle);
  }
  if (filters.hasSale === false) {
    where.push("0 = 1");
  }
  if (filters.listedOnly) where.push("assets.is_listed = 1");
  if (filters.soldOnly || filters.hasSale === true) where.push("assets.last_sale_tx_signature IS NOT NULL");

  const order = filters.sort === "oldest"
    ? "events.event_at ASC"
    : filters.sort === "price_sol_high" || filters.sort === "price_desc"
      ? "events.price_sol IS NULL ASC, events.price_sol DESC, events.event_at DESC"
      : filters.sort === "price_sol_low" || filters.sort === "price_asc"
        ? "events.price_sol IS NULL ASC, events.price_sol ASC, events.event_at DESC"
    : filters.sort === "price_usd_high"
      ? "events.price_usd IS NULL ASC, events.price_usd DESC, events.event_at DESC"
      : filters.sort === "price_usd_low"
        ? "events.price_usd IS NULL ASC, events.price_usd ASC, events.event_at DESC"
        : filters.sort === "growth_high"
          ? "events.price_change_percent IS NULL ASC, events.price_change_percent DESC, events.event_at DESC"
          : filters.sort === "growth_low"
            ? "events.price_change_percent IS NULL ASC, events.price_change_percent ASC, events.event_at DESC"
            : "events.event_at DESC";

  const totalRow = getNftDb().prepare(`
    SELECT COUNT(*) AS count
    FROM rwa_nft_events events
    JOIN nft_assets assets ON assets.mint = events.mint
    WHERE ${where.join(" AND ")}
  `).get(...params);

  const pagedParams = [...params, limit, (page - 1) * limit];
  const rows = getNftDb().prepare(`
    SELECT
      events.id, events.mint, events.category, events.price_sol, events.price_usd,
      events.payment_mint, events.payment_symbol, events.payment_amount, events.marketplace,
      events.previous_sale_amount, events.previous_sale_symbol, events.previous_sale_tx_signature,
      events.price_change_amount, events.price_change_percent, events.price_change_direction,
      events.tx_signature, events.buyer, events.seller, events.event_at, events.source, events.raw_payload_json,
      assets.name, assets.image, assets.collection, assets.owner,
      assets.current_status, assets.is_listed, assets.listed_price_sol, assets.listed_price_usd,
      assets.latest_purchase_price_sol, assets.latest_purchase_price_usd,
      assets.latest_market_price_sol, assets.latest_market_price_usd,
      assets.latest_marketplace, assets.latest_provider, assets.latest_tx_hash,
      assets.last_checked_at, assets.validation_status,
      assets.last_sale_price_sol, assets.last_sale_price_usd, assets.last_sale_at, assets.last_sale_marketplace
    FROM rwa_nft_events events
    JOIN nft_assets assets ON assets.mint = events.mint
    WHERE ${where.join(" AND ")}
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `).all(...pagedParams);

  return {
    page,
    limit,
    total: Number(totalRow?.count ?? 0),
    sales: rows.map((row): VerifiedSale => ({
      id: String(row.id),
      mint: String(row.mint),
      category: String(row.category),
      priceSol: asNumber(row.price_sol),
      priceUsd: asNumber(row.price_usd),
      paymentMint: asString(row.payment_mint),
      paymentSymbol: asString(row.payment_symbol),
      paymentAmount: asNumber(row.payment_amount),
      previousSaleAmount: asNumber(row.previous_sale_amount),
      previousSaleSymbol: asString(row.previous_sale_symbol),
      previousSaleTxSignature: asString(row.previous_sale_tx_signature),
      priceChangeAmount: asNumber(row.price_change_amount),
      priceChangePercent: asNumber(row.price_change_percent),
      priceChangeDirection: asString(row.price_change_direction) as VerifiedSale["priceChangeDirection"],
      marketplace: asString(row.marketplace),
      txSignature: String(row.tx_signature),
      buyer: asString(row.buyer),
      seller: asString(row.seller),
      eventAt: String(row.event_at),
      source: String(row.source) as RwaNftMarketEventSource,
      fallbackVerified: inferFallbackVerified(parseJson(row.raw_payload_json, null)),
      isTestSale: isTestSignature(String(row.tx_signature)),
      name: asString(row.name),
      image: asString(row.image),
      collection: asString(row.collection),
      owner: asString(row.owner),
      currentStatus: asString(row.current_status) as VerifiedSale["currentStatus"],
      isListed: Boolean(row.is_listed),
      latestListingPriceSol: asNumber(row.listed_price_sol),
      latestListingPriceUsd: asNumber(row.listed_price_usd),
      latestPurchasePriceSol: asNumber(row.latest_purchase_price_sol) ?? asNumber(row.last_sale_price_sol),
      latestPurchasePriceUsd: asNumber(row.latest_purchase_price_usd) ?? asNumber(row.last_sale_price_usd),
      latestMarketPriceSol: asNumber(row.latest_market_price_sol) ?? asNumber(row.last_sale_price_sol) ?? asNumber(row.listed_price_sol),
      latestMarketPriceUsd: asNumber(row.latest_market_price_usd) ?? asNumber(row.last_sale_price_usd) ?? asNumber(row.listed_price_usd),
      latestMarketplace: asString(row.latest_marketplace) ?? asString(row.marketplace),
      latestProvider: asString(row.latest_provider) ?? asString(row.source),
      latestTxHash: asString(row.latest_tx_hash) ?? String(row.tx_signature),
      lastCheckedAt: asString(row.last_checked_at),
      validationStatus: asString(row.validation_status) as VerifiedSale["validationStatus"],
      lastSalePriceSol: asNumber(row.last_sale_price_sol),
      lastSalePriceUsd: asNumber(row.last_sale_price_usd),
      lastSaleAt: asString(row.last_sale_at),
      lastSaleMarketplace: asString(row.last_sale_marketplace),
    })),
  };
}

export async function getListedNfts(filters: MarketEventFilters = {}) {
  const limit = cleanLimit(filters.limit);
  const page = cleanPage(filters.page);
  const where = ["is_listed = 1", "is_staging = 0", "category IS NOT NULL", "category != 'unknown'"];
  const params: unknown[] = [];
  if (filters.category && filters.category !== "all") {
    where.push("category = ?");
    params.push(filters.category);
  }
  const order = filters.sort === "price_desc"
    ? "listed_price_sol DESC"
    : filters.sort === "price_asc"
      ? "listed_price_sol ASC"
      : "listing_updated_at DESC";
  params.push(limit, (page - 1) * limit);
  return getNftDb().prepare(`SELECT * FROM nft_assets WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params);
}

export async function getRwaMarketStats(category?: string | null) {
  const params: unknown[] = [];
  const categoryWhere = category && category !== "all" ? "AND category = ?" : "";
  if (categoryWhere) params.push(category);
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const listed = getNftDb().prepare(`SELECT COUNT(*) AS count, MIN(listed_price_sol) AS floor FROM nft_assets WHERE is_listed = 1 AND is_staging = 0 AND category != 'unknown' ${categoryWhere}`).get(...params);
  const latestSale = getNftDb().prepare(`SELECT price_sol, price_usd, event_at FROM rwa_nft_events WHERE event_type = 'SALE' AND tx_signature IS NOT NULL AND category != 'unknown' ${categoryWhere} ORDER BY event_at DESC LIMIT 1`).get(...params);
  const stats24h = getNftDb().prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(price_usd), 0) AS volumeUsd, COALESCE(SUM(price_sol), 0) AS volumeSol FROM rwa_nft_events WHERE event_type = 'SALE' AND tx_signature IS NOT NULL AND event_at >= ? ${categoryWhere}`).get(dayAgo, ...params);
  const stats7d = getNftDb().prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(price_usd), 0) AS volumeUsd, COALESCE(SUM(price_sol), 0) AS volumeSol FROM rwa_nft_events WHERE event_type = 'SALE' AND tx_signature IS NOT NULL AND event_at >= ? ${categoryWhere}`).get(weekAgo, ...params);

  return {
    listedCount: Number(listed?.count ?? 0),
    floorPriceSol: asNumber(listed?.floor),
    latestSalePriceSol: asNumber(latestSale?.price_sol),
    latestSalePriceUsd: asNumber(latestSale?.price_usd),
    latestSaleAt: asString(latestSale?.event_at),
    salesCount24h: Number(stats24h?.count ?? 0),
    volume24hUsd: Number(stats24h?.volumeUsd ?? 0),
    volume24hSol: Number(stats24h?.volumeSol ?? 0),
    salesCount7d: Number(stats7d?.count ?? 0),
    volume7dUsd: Number(stats7d?.volumeUsd ?? 0),
    volume7dSol: Number(stats7d?.volumeSol ?? 0),
  };
}

export function marketEventFromDbRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    mint: String(row.mint),
    category: asString(row.category),
    eventType: String(row.event_type),
    priceSol: asNumber(row.price_sol),
    priceUsd: asNumber(row.price_usd),
    paymentMint: asString(row.payment_mint),
    paymentSymbol: asString(row.payment_symbol),
    paymentAmount: asNumber(row.payment_amount),
    previousSaleAmount: asNumber(row.previous_sale_amount),
    previousSaleSymbol: asString(row.previous_sale_symbol),
    previousSaleTxSignature: asString(row.previous_sale_tx_signature),
    priceChangeAmount: asNumber(row.price_change_amount),
    priceChangePercent: asNumber(row.price_change_percent),
    priceChangeDirection: asString(row.price_change_direction),
    marketplace: asString(row.marketplace),
    txSignature: asString(row.tx_signature),
    buyer: asString(row.buyer),
    seller: asString(row.seller),
    owner: asString(row.owner),
    eventAt: String(row.event_at),
    source: String(row.source),
    rawPayload: parseJson(row.raw_payload_json, null),
  };
}
