import type { NFTListingState, NFTMarketState, ProviderScanStatus, RwaNftMarketEvent } from "@/types/rwaNftMarket";
import { createMarketActivityConnectors, getMarketActivityProviderStatusReport } from "./nftMarketActivityConnectors";
import { getNftDb, sqliteBool, stringifyJson } from "./nftSqliteDb";
import { getNFTMarketState, refreshNFTMarketStateForMint } from "./nftMarketStateService";
import { readNftScannerConfig } from "./nftScannerConfig";
import { saveProviderScanStatus } from "./nftScannerStatusService";
import { saveRwaNftMarketEvent } from "./rwaNftMarketEventService";

type SqlRow = Record<string, unknown>;

export type ScanAllNFTMarketStatesOptions = {
  mint?: string | null;
  limit?: number | null;
  all?: boolean;
  dryRun?: boolean | null;
};

export type ScanAllNFTMarketStatesResult = {
  dryRun: boolean;
  scannerEnabled: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  nftsChecked: number;
  listingsFound: number;
  salesFound: number;
  verifiedSalesStored: number;
  statesUpdated: number;
  errors: Array<{ mint: string; provider?: string; error: string }>;
  providerStatuses: ProviderScanStatus[];
  preview: NFTMarketState[];
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nowIso() {
  return new Date().toISOString();
}

function selectNfts(options: ScanAllNFTMarketStatesOptions, fallbackLimit: number) {
  const db = getNftDb();
  const params: unknown[] = [];
  let sql = `
    SELECT mint
    FROM nft_assets
  `;

  if (options.mint) {
    sql += " WHERE mint = ?";
    params.push(options.mint);
  }

  sql += " ORDER BY last_checked_at IS NULL DESC, last_checked_at ASC, updated_at DESC";

  if (!options.mint && !options.all) {
    sql += " LIMIT ?";
    params.push(Math.max(Math.trunc(options.limit ?? fallbackLimit), 1));
  } else if (!options.mint && options.limit && options.limit > 0) {
    sql += " LIMIT ?";
    params.push(Math.trunc(options.limit));
  }

  return db.prepare(sql).all(...params) as Array<{ mint: string }>;
}

async function withRetries<T>(input: { retries: number; mint: string; provider: string; action: () => Promise<T> }): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= input.retries; attempt += 1) {
    try {
      return await input.action();
    } catch (error) {
      lastError = error;
      if (attempt < input.retries) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${input.provider} failed for ${input.mint}`);
}

function upsertListingState(listing: NFTListingState) {
  const timestamp = nowIso();
  const id = listing.id ?? `${listing.provider}-${listing.assetMint}-${listing.listingId ?? "active"}`.toLowerCase();
  getNftDb().prepare(`
    INSERT INTO nft_listing_states (
      id, asset_mint, provider, marketplace, listing_id, seller_wallet, price_sol, price_usd,
      currency, is_active, listed_at, last_seen_at, raw_payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, asset_mint, listing_id) DO UPDATE SET
      marketplace = excluded.marketplace,
      seller_wallet = excluded.seller_wallet,
      price_sol = excluded.price_sol,
      price_usd = excluded.price_usd,
      currency = excluded.currency,
      is_active = excluded.is_active,
      listed_at = COALESCE(excluded.listed_at, nft_listing_states.listed_at),
      last_seen_at = excluded.last_seen_at,
      raw_payload_json = excluded.raw_payload_json,
      updated_at = excluded.updated_at
  `).run(
    id,
    listing.assetMint,
    listing.provider,
    listing.marketplace,
    listing.listingId ?? "",
    listing.sellerWallet,
    listing.priceSol,
    listing.priceUsd,
    listing.currency,
    sqliteBool(listing.isActive),
    listing.listedAt,
    listing.lastSeenAt ?? timestamp,
    stringifyJson(listing.rawPayload),
    timestamp,
    timestamp,
  );

  getNftDb().prepare(`
    UPDATE nft_assets SET
      is_listed = ?,
      listed_price_sol = ?,
      listed_price_usd = ?,
      listing_marketplace = ?,
      listing_updated_at = ?,
      current_status = CASE WHEN ? = 1 THEN 'listed' ELSE current_status END,
      latest_market_price_sol = COALESCE(latest_market_price_sol, ?),
      latest_market_price_usd = COALESCE(latest_market_price_usd, ?),
      latest_marketplace = COALESCE(latest_marketplace, ?),
      latest_provider = COALESCE(latest_provider, ?),
      last_checked_at = ?,
      market_updated_at = ?,
      updated_at = ?
    WHERE mint = ?
  `).run(
    sqliteBool(listing.isActive),
    listing.priceSol,
    listing.priceUsd,
    listing.marketplace,
    listing.lastSeenAt ?? timestamp,
    sqliteBool(listing.isActive),
    listing.priceSol,
    listing.priceUsd,
    listing.marketplace,
    listing.provider,
    timestamp,
    timestamp,
    timestamp,
    listing.assetMint,
  );
}

function providerStatusFromRun(input: {
  provider: string;
  scanType: ProviderScanStatus["scanType"];
  startedAt: string;
  durationMs: number;
  itemsChecked: number;
  itemsFound: number;
  itemsStored: number;
  errors: number;
}): ProviderScanStatus {
  return {
    provider: input.provider,
    scanType: input.scanType,
    status: input.errors > 0 ? "error" : "live",
    lastRunAt: input.startedAt,
    lastSuccessAt: input.errors > 0 ? null : nowIso(),
    lastError: input.errors > 0 ? `${input.errors} item(s) failed` : null,
    itemsChecked: input.itemsChecked,
    itemsFound: input.itemsFound,
    itemsStored: input.itemsStored,
    durationMs: input.durationMs,
  };
}

export async function scanAllNFTMarketStates(options: ScanAllNFTMarketStatesOptions = {}): Promise<ScanAllNFTMarketStatesResult> {
  const config = readNftScannerConfig({ dryRun: options.dryRun });
  const startedAt = nowIso();
  const startMs = Date.now();
  const connectors = createMarketActivityConnectors();
  const rows = config.enabled ? selectNfts(options, config.batchSize) : [];
  const errors: ScanAllNFTMarketStatesResult["errors"] = [];
  const preview: NFTMarketState[] = [];
  const providerCounters = new Map<string, { checked: number; found: number; stored: number; errors: number }>();
  let listingsFound = 0;
  let salesFound = 0;
  let verifiedSalesStored = 0;
  let statesUpdated = 0;

  console.log(`[NFT SCANNER] Starting market-state scan dryRun=${config.dryRun} batchSize=${config.batchSize}`);

  for (const row of rows) {
    const mint = row.mint;
    let latestProviderPayloads: unknown[] = [];

    for (const connector of connectors) {
      const counter = providerCounters.get(connector.providerId) ?? { checked: 0, found: 0, stored: 0, errors: 0 };
      counter.checked += 1;
      providerCounters.set(connector.providerId, counter);

      try {
        const listing = await withRetries({
          retries: config.maxRetries,
          mint,
          provider: connector.providerId,
          action: () => connector.fetchActiveListingForNFT(mint),
        });
        if (listing) {
          listingsFound += 1;
          counter.found += 1;
          latestProviderPayloads.push(listing.rawPayload);
          if (config.dryRun) {
            console.log(`[NFT SCANNER][DRY RUN] Listing would update ${mint} from ${connector.providerId}`);
          } else {
            upsertListingState(listing);
            counter.stored += 1;
          }
        }

        const sale = await withRetries({
          retries: config.maxRetries,
          mint,
          provider: connector.providerId,
          action: () => connector.fetchLatestSaleForNFT(mint),
        });
        if (sale) {
          salesFound += 1;
          counter.found += 1;
          latestProviderPayloads.push(sale.rawPayload);
          if (config.dryRun) {
            console.log(`[NFT SCANNER][DRY RUN] Verified SALE would be saved for ${mint} tx=${sale.txSignature ?? "missing"}`);
          } else {
            const result = await saveRwaNftMarketEvent(sale as RwaNftMarketEvent);
            if (result.saved) {
              verifiedSalesStored += 1;
              counter.stored += 1;
            }
          }
        }
      } catch (error) {
        counter.errors += 1;
        errors.push({ mint, provider: connector.providerId, error: error instanceof Error ? error.message : "Provider scan failed" });
      }
    }

    try {
      const state = config.dryRun ? await getNFTMarketState(mint) : await refreshNFTMarketStateForMint(mint);
      if (state) {
        statesUpdated += config.dryRun ? 0 : 1;
        preview.push({ ...state, rawProviderPayloads: latestProviderPayloads });
      }
    } catch (error) {
      errors.push({ mint, error: error instanceof Error ? error.message : "Market-state update failed" });
    }
  }

  const providerStatuses: ProviderScanStatus[] = [];
  const durationMs = Date.now() - startMs;
  for (const connector of connectors) {
    const counter = providerCounters.get(connector.providerId) ?? { checked: 0, found: 0, stored: 0, errors: 0 };
    const status = providerStatusFromRun({
      provider: connector.providerId,
      scanType: "market_state",
      startedAt,
      durationMs,
      itemsChecked: counter.checked,
      itemsFound: counter.found,
      itemsStored: counter.stored,
      errors: counter.errors,
    });
    providerStatuses.push(status);
    saveProviderScanStatus(status, { dryRun: config.dryRun });
  }

  const finishedAt = nowIso();
  console.log(`[NFT SCANNER] Market-state scan completed checked=${rows.length} listings=${listingsFound} sales=${salesFound} stored=${verifiedSalesStored} errors=${errors.length}`);

  return {
    dryRun: config.dryRun,
    scannerEnabled: config.enabled,
    startedAt,
    finishedAt,
    durationMs,
    nftsChecked: rows.length,
    listingsFound,
    salesFound,
    verifiedSalesStored,
    statesUpdated,
    errors,
    providerStatuses,
    preview: preview.slice(0, 25),
  };
}

export function currentMarketActivityProviderStatuses() {
  return getMarketActivityProviderStatusReport().marketActivityProviders;
}
