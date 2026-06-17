import type { NFTLastActivityType, NFTMarketStatus, NFTMetadataStatus, ProviderScanStatus, RwaNftMarketEvent } from "@/types/rwaNftMarket";
import { parseHeliusEnhancedTransaction } from "./heliusEnhancedTransactionParser";
import { getAssetByMint, normalizeHeliusAsset } from "./heliusNftService";
import { lookupActiveListingByMint, type ActiveMintListingLookupResult } from "./nftMarketplaceListingService";
import { detectCollectibleAssetType, publicGroupForAssetType } from "./nftAssetTypeService";
import { detectRwaNftCategory, isAllowedRwaNftCategory } from "./nftCategoryService";
import { getNftDb, shouldStoreRawHeliusJson, sqliteBool, stringifyJson } from "./nftSqliteDb";
import { readNftScannerConfig } from "./nftScannerConfig";
import { saveProviderScanStatus } from "./nftScannerStatusService";
import { saveRwaNftMarketEvent } from "./rwaNftMarketEventService";
import { fetchWithHeliusKey, hasHeliusApiKey } from "./heliusApiKeyRotation";
import { fetchShyftAssetByMint, hasShyftApiKey } from "./shyftNftService";
import {
  fetchSolscanNftActivity,
  getProviderStrategyConfig,
  logProviderStrategy,
  type NftActivityProviderId,
  type NftActivityProviderResult,
} from "./solscanNftActivityService";

type RuntimeEnv = Record<string, string | undefined>;
type SqlRow = Record<string, unknown>;
type MetadataProviderId = "shyft" | "helius" | "cache";

export type EnrichNFTListOptions = {
  mint?: string | null;
  limit?: number | null;
  dryRun?: boolean | null;
  lane?: "all" | "hot" | "cold" | null;
};

type EnrichedNftChange = {
  mint: string;
  nameUpdated: boolean;
  imageUpdated: boolean;
  ownerUpdated: boolean;
  assetTypeUpdated: boolean;
  categoryUpdated: boolean;
  lastActivityUpdated: boolean;
  providerUpdated: boolean;
  metadataStatus: NFTMetadataStatus;
  currentState: NFTMarketStatus;
  lastActivityType: NFTLastActivityType;
  lastActivityAt: string | null;
  lastActivityTxHash: string | null;
};

export type EnrichNFTListResult = {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  nftsChecked: number;
  metadataUpdated: number;
  imagesUpdated: number;
  ownersUpdated: number;
  assetTypesUpdated: number;
  categoriesUpdated: number;
  lastActivitiesDetected: number;
  lastActivitiesUpdated: number;
  verifiedSalesDetected: number;
  verifiedSalesStored: number;
  providersUsed: string[];
  errors: Array<{ mint: string; error: string }>;
  changes: EnrichedNftChange[];
  providerStatuses: ProviderScanStatus[];
};

const HELIUS_RPC_URL = "https://mainnet.helius-rpc.com/";
const HELIUS_ENHANCED_TX_URL = "https://api.helius.xyz/v0/transactions/";
const COLLECTOR_CRYPT_PROGRAM_ID = "CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr";
const EMPTY_ACTIVITY_DEBUG = {
  txHash: null,
  detectedType: null,
  currentOwner: null,
  nftReceiver: null,
  source: null,
  description: null,
  instructionPrograms: [],
  matchedAllowlistAccounts: [],
  matchedPackSignal: false,
  nativeTransfers: [],
  tokenTransfers: [],
  nftTransfers: [],
};
function env(): RuntimeEnv {
  return (globalThis as unknown as { process?: { env?: RuntimeEnv } }).process?.env ?? {};
}

function nowIso() {
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function isMissingText(value: unknown) {
  const text = String(value ?? "").trim();
  return !text || text === "- NULL -" || text.toLowerCase() === "null" || text.toLowerCase() === "unknown";
}

function selectAssets(options: EnrichNFTListOptions, limit: number) {
  const params: unknown[] = [];
  const where: string[] = [];
  let sql = "SELECT * FROM nft_assets";
  if (options.mint) {
    where.push("mint = ?");
    params.push(options.mint);
  } else if (options.lane === "hot") {
    where.push("(last_sale_at IS NOT NULL OR latest_market_price_sol IS NOT NULL OR latest_market_price_usd IS NOT NULL OR listed_price_sol IS NOT NULL OR listed_price_usd IS NOT NULL OR COALESCE(last_activity_type, 'unknown') != 'unknown')");
  } else if (options.lane === "cold") {
    where.push("(last_sale_at IS NULL AND latest_market_price_sol IS NULL AND latest_market_price_usd IS NULL AND listed_price_sol IS NULL AND listed_price_usd IS NULL AND COALESCE(last_activity_type, 'unknown') = 'unknown' AND last_activity_at IS NULL)");
  }
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  const orderBy = options.lane === "cold"
    ? "last_checked_at IS NULL DESC, last_checked_at ASC, updated_at ASC"
    : "CASE WHEN last_sale_at IS NOT NULL OR latest_market_price_sol IS NOT NULL OR latest_market_price_usd IS NOT NULL OR listed_price_sol IS NOT NULL OR listed_price_usd IS NOT NULL THEN 0 WHEN COALESCE(last_activity_type, 'unknown') != 'unknown' THEN 1 WHEN metadata_status IS NULL OR metadata_status != 'complete' OR image IS NULL OR image = '' OR owner IS NULL OR owner = '' THEN 2 ELSE 3 END ASC, last_checked_at IS NULL DESC, last_checked_at ASC, updated_at DESC";
  sql += ` ORDER BY ${orderBy}`;
  if (!options.mint) {
    sql += " LIMIT ?";
    params.push(Math.max(Math.trunc(options.limit ?? limit), 1));
  }
  return getNftDb().prepare(sql).all(...params) as SqlRow[];
}

function loadAssetByMint(mint: string) {
  return getNftDb().prepare("SELECT * FROM nft_assets WHERE mint = ?").get(mint) as SqlRow | undefined;
}

function parseDate(value: unknown) {
  const text = asString(value);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : null;
}

function rowMetadataStatus(row: SqlRow) {
  const value = asString(row.metadata_status);
  if (value) return value;
  const complete = Boolean(asString(row.name) && asString(row.image) && asString(row.owner));
  if (complete) return "complete";
  if (asString(row.name) || asString(row.image) || asString(row.owner)) return "partial";
  return "missing";
}

function rowToNftDto(row: SqlRow) {
  return {
    assetMint: asString(row.mint),
    assetName: asString(row.name),
    imageUrl: asString(row.image),
    market: asString(row.market),
    category: asString(row.category) ?? "unknown",
    collectionSlug: asString(row.source_collection) ?? asString(row.collection),
    collectionName: asString(row.collection_name) ?? asString(row.collection),
    assetType: asString(row.asset_type) ?? "unknown",
    ownerWallet: asString(row.owner),
    source: asString(row.source_collection),
    provider: asString(row.source_provider) ?? asString(row.latest_provider),
    isListed: Boolean(row.is_listed),
    currentState: asString(row.current_state) ?? asString(row.current_status) ?? "unknown",
    lastActivityType: asString(row.last_activity_type) ?? "unknown",
    lastActivityAt: asString(row.last_activity_at),
    lastActivityTxHash: asString(row.last_activity_tx_hash),
    lastActivityProvider: asString(row.last_activity_provider),
    latestListingPriceSol: typeof row.listed_price_sol === "number" ? row.listed_price_sol : null,
    latestListingPriceUsd: typeof row.listed_price_usd === "number" ? row.listed_price_usd : null,
    listingMarketplace: asString(row.listing_marketplace),
    lastListedAt: asString(row.listing_updated_at),
    latestMarketPriceSol: typeof row.latest_market_price_sol === "number" ? row.latest_market_price_sol : null,
    latestMarketPriceUsd: typeof row.latest_market_price_usd === "number" ? row.latest_market_price_usd : null,
    latestPurchasePriceSol: typeof row.latest_purchase_price_sol === "number" ? row.latest_purchase_price_sol : null,
    latestPurchasePriceUsd: typeof row.latest_purchase_price_usd === "number" ? row.latest_purchase_price_usd : null,
    latestMarketplace: asString(row.latest_marketplace),
    latestProvider: asString(row.latest_provider),
    latestTxHash: asString(row.latest_tx_hash),
    lastCheckedAt: asString(row.last_checked_at),
    metadataStatus: rowMetadataStatus(row),
    validationStatus: asString(row.validation_status) ?? "unverified",
    updatedAt: asString(row.updated_at),
    lastSalePriceSol: typeof row.last_sale_price_sol === "number" ? row.last_sale_price_sol : null,
    lastSalePriceUsd: typeof row.last_sale_price_usd === "number" ? row.last_sale_price_usd : null,
    lastSaleAt: asString(row.last_sale_at),
    lastSaleMarketplace: asString(row.last_sale_marketplace),
  };
}

function normalizedFromCachedRow(row: SqlRow, mint: string): ReturnType<typeof normalizeHeliusAsset> {
  return {
    mint,
    name: asString(row.name),
    description: asString(row.description),
    image: asString(row.image),
    owner: asString(row.owner),
    collection: asString(row.collection) ?? asString(row.source_collection),
    market: asString(row.market) ?? asString(row.category) ?? "unknown",
    category: asString(row.category),
    attributes: Array.isArray(row.attributes_json)
      ? row.attributes_json
      : typeof row.attributes_json === "string"
        ? (() => {
            try {
              const parsed = JSON.parse(row.attributes_json);
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          })()
        : [],
    tokenStandard: asString(row.token_standard),
    interface: asString(row.interface),
    rawSource: "helius",
    updatedAt: nowIso(),
  };
}

function isCompleteMetadata(normalized: ReturnType<typeof normalizeHeliusAsset>) {
  return Boolean(normalized.name && normalized.image && normalized.owner && normalized.collection);
}

async function loadMetadataForMint(input: {
  mint: string;
  row: SqlRow | undefined;
  market: string;
  retries: number;
}): Promise<{
  rawAsset: unknown;
  normalized: ReturnType<typeof normalizeHeliusAsset>;
  metadataProvider: MetadataProviderId;
  providerStatus: "ok" | "incomplete" | "error" | "unavailable";
  usedFallback: boolean;
}> {
  const strategy = getProviderStrategyConfig();

  if (hasShyftApiKey()) {
    const shyft = await fetchShyftAssetByMint({
      mint: input.mint,
      owner: asString(input.row?.owner),
      collection: asString(input.row?.collection) ?? asString(input.row?.source_collection),
    });
    if (shyft.asset) {
      const normalized = normalizeHeliusAsset(shyft.asset, input.market);
      if (isCompleteMetadata(normalized)) {
        logProviderStrategy({
          mint: input.mint,
          requestedDataType: "metadata",
          primaryProvider: strategy.metadataPrimaryProvider,
          providerCalled: "shyft",
          fallbackUsed: false,
          providerStatus: "ok",
          dbCacheUsed: false,
        });
        return { rawAsset: shyft.asset, normalized, metadataProvider: "shyft", providerStatus: "ok", usedFallback: false };
      }
      logProviderStrategy({
        mint: input.mint,
        requestedDataType: "metadata",
        primaryProvider: strategy.metadataPrimaryProvider,
        providerCalled: "shyft",
        fallbackUsed: true,
        providerStatus: "incomplete",
        dbCacheUsed: false,
      });
    }

    if (shyft.status !== "unavailable") {
      if (!shyft.asset) {
        logProviderStrategy({
          mint: input.mint,
          requestedDataType: "metadata",
          primaryProvider: strategy.metadataPrimaryProvider,
          providerCalled: "shyft",
          fallbackUsed: true,
          providerStatus: shyft.status,
          dbCacheUsed: false,
        });
      }
    }
  }

  if (hasHeliusApiKey()) {
    const rawAsset = await withRetries(input.retries, () => getAssetByMint(input.mint));
    const normalized = normalizeHeliusAsset(rawAsset, input.market);
    logProviderStrategy({
      mint: input.mint,
      requestedDataType: "metadata",
      primaryProvider: strategy.metadataPrimaryProvider,
      providerCalled: "helius",
      fallbackUsed: true,
      providerStatus: "ok",
      dbCacheUsed: false,
    });
    return { rawAsset, normalized, metadataProvider: "helius", providerStatus: "ok", usedFallback: true };
  }

  if (input.row) {
    const normalized = normalizedFromCachedRow(input.row, input.mint);
    logProviderStrategy({
      mint: input.mint,
      requestedDataType: "metadata",
      primaryProvider: strategy.metadataPrimaryProvider,
      providerCalled: "cache",
      fallbackUsed: true,
      providerStatus: "stale",
      dbCacheUsed: true,
    });
    return { rawAsset: { source: "cache", mint: input.mint }, normalized, metadataProvider: "cache", providerStatus: "stale", usedFallback: true };
  }

  throw new Error("No metadata provider available");
}

function rowNeedsRefresh(row: SqlRow | undefined, ttlSeconds: number) {
  if (!row) return true;
  const ttlMs = ttlSeconds * 1000;
  const checkedAt = parseDate(row.last_checked_at);
  const ageMs = checkedAt ? Date.now() - checkedAt : Number.POSITIVE_INFINITY;
  const stale = !checkedAt || ageMs > ttlMs;
  const incomplete = rowMetadataStatus(row) !== "complete" || !asString(row.owner) || !asString(row.image);
  return stale || incomplete;
}

function shouldFetchDetailedHistory(input: {
  row: SqlRow | undefined;
  lane: "all" | "hot" | "cold" | null | undefined;
  owner: string | null;
  focusMint: boolean;
}) {
  if (!input.row || input.focusMint) return true;

  const ownerChanged = Boolean(input.owner && asString(input.row.owner) && asString(input.row.owner) !== input.owner);
  const metadataIncomplete = rowMetadataStatus(input.row) !== "complete" || !asString(input.row.owner) || !asString(input.row.image);
  const storedActivityType = asString(input.row.last_activity_type) ?? "unknown";
  const hasMarketData = Boolean(
    asString(input.row.last_sale_at)
    || numberFromUnknown(input.row.last_sale_price_sol) != null
    || numberFromUnknown(input.row.last_sale_price_usd) != null
    || numberFromUnknown(input.row.latest_market_price_sol) != null
    || numberFromUnknown(input.row.latest_market_price_usd) != null
    || numberFromUnknown(input.row.listed_price_sol) != null
    || numberFromUnknown(input.row.listed_price_usd) != null
  );
  const checkedAtMs = parseDate(input.row.last_checked_at) ?? 0;
  const detailedHistoryAgeMs = checkedAtMs ? Date.now() - checkedAtMs : Number.POSITIVE_INFINITY;

  if (input.lane === "cold") {
    return metadataIncomplete || ownerChanged || !checkedAtMs;
  }

  if (input.lane === "hot") {
    if (ownerChanged || metadataIncomplete) return true;
    if (storedActivityType === "unknown" || !hasMarketData) return true;
    return detailedHistoryAgeMs > 6 * 60 * 60 * 1000;
  }

  return true;
}

function refreshCooldownActive(row: SqlRow | undefined, cooldownSeconds: number) {
  if (!row) return false;
  const lastCheckedAt = parseDate(row.last_checked_at);
  if (!lastCheckedAt) return false;
  return Date.now() - lastCheckedAt < cooldownSeconds * 1000;
}

function mergePreviewRow(baseRow: SqlRow | undefined, next: Partial<Record<string, unknown>>) {
  return { ...(baseRow ?? {}), ...next } as SqlRow;
}

async function heliusRpc(method: string, params: unknown) {
  if (!hasHeliusApiKey()) throw new Error("Missing HELIUS_API_KEY");
  const response = await fetchWithHeliusKey({
    label: `nft-list:${method}`,
    endpoint: HELIUS_RPC_URL,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    },
  });
  const payload = await response.json() as { result?: unknown; error?: { message?: string } };
  if (!response.ok || payload.error) throw new Error(payload.error?.message ?? `Helius ${method} failed: ${response.status}`);
  return payload.result;
}

async function recentSignaturesForMint(mint: string, limit = 8) {
  const result = await heliusRpc("getSignaturesForAddress", [mint, { limit }]);
  return Array.isArray(result) ? result.map(asRecord) : [];
}

async function rpcTransactionRecords(signatures: string[]) {
  const records: Record<string, unknown>[] = [];
  for (const signature of signatures) {
    try {
      const result = asRecord(await heliusRpc("getTransaction", [
        signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]));
      const transaction = asRecord(result.transaction);
      const message = asRecord(transaction.message);
      const meta = asRecord(result.meta);
      const accountKeys = (Array.isArray(message.accountKeys) ? message.accountKeys : []).map((account) => {
        const row = asRecord(account);
        return {
          account: asString(row.pubkey) ?? (typeof account === "string" ? account : null),
        };
      }).filter((account) => account.account);
      const instructions = (Array.isArray(message.instructions) ? message.instructions : []).map((instruction) => {
        const row = asRecord(instruction);
        return {
          programId: asString(row.programId) ?? asString(row.program),
          programName: asString(row.program),
        };
      });
      records.push({
        signature,
        transactionSignature: signature,
        timestamp: result.blockTime,
        instructions,
        accountData: accountKeys,
        logMessages: Array.isArray(meta.logMessages) ? meta.logMessages : [],
        meta,
      });
    } catch (error) {
      console.log(`[NFT TX LOGS] ${signature} unavailable: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }
  return records;
}

async function enhancedTransactions(signatures: string[]) {
  if (!hasHeliusApiKey() || signatures.length === 0) return [];
  const response = await fetchWithHeliusKey({
    label: "nft-list:enhanced-transactions",
    endpoint: HELIUS_ENHANCED_TX_URL,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactions: signatures }),
    },
  });
  if (!response.ok) {
    const fallbackRecords = await rpcTransactionRecords(signatures);
    if (fallbackRecords.length) return fallbackRecords;
    throw new Error(`Helius Enhanced Transactions failed: ${response.status}`);
  }
  const payload = await response.json() as unknown;
  const enhancedRecords = Array.isArray(payload) ? payload.map(asRecord) : [];
  const rpcRecords = await rpcTransactionRecords(signatures);
  const rpcBySignature = new Map(rpcRecords.map((record) => [txSignature(record), record]));
  return enhancedRecords.map((record) => {
    const signature = txSignature(record);
    const rpcRecord = signature ? rpcBySignature.get(signature) : null;
    return rpcRecord ? { ...rpcRecord, ...record, logMessages: rpcRecord.logMessages, meta: rpcRecord.meta } : record;
  });
}

function timestampFromTx(tx: Record<string, unknown>) {
  const raw = tx.timestamp ?? tx.blockTime ?? tx.createdAt ?? tx.time;
  if (typeof raw === "number") return new Date(raw < 10_000_000_000 ? raw * 1000 : raw).toISOString();
  return asString(raw);
}

function txSignature(tx: Record<string, unknown>) {
  return asString(tx.signature) ?? asString(tx.transactionSignature) ?? asString(tx.txHash);
}

// Maps Helius Enhanced Transaction tx.type values to our internal activity
// type. Helius documents these at https://docs.helius.dev/data-streaming/enhanced-transactions/transaction-types.
// We don't enumerate every variant — only the ones we want to route, and let
// the fallback text matchers handle the long tail.
function classifyByHeliusType(
  txType: string,
  owner: string | null,
): { type: NFTLastActivityType; state: NFTMarketStatus } | null {
  if (!txType) return null;
  if (txType === "NFT_SALE" || txType === "TOKEN_SALE" || txType === "NFT_AUCTION_WON") {
    return { type: owner ? "bought" : "sold", state: owner ? "owned" : "sold" };
  }
  if (txType === "NFT_LISTING" || txType === "NFT_LISTING_UPDATE" || txType === "NFT_AUCTION_CREATED") {
    return { type: "listed", state: "listed" };
  }
  if (txType === "NFT_CANCEL_LISTING" || txType === "NFT_AUCTION_CANCELLED") {
    return { type: "delisted", state: "unlisted" };
  }
  if (txType === "NFT_BID" || txType === "NFT_GLOBAL_BID" || txType === "OFFER_PLACED") {
    return { type: "bid", state: owner ? "owned" : "unknown" };
  }
  if (txType === "OFFER_CANCELED" || txType === "OFFER_CANCELLED" || txType === "NFT_BID_CANCELLED") {
    return { type: "delisted", state: owner ? "owned" : "unknown" };
  }
  if (txType === "NFT_MINT" || txType === "TOKEN_MINT" || txType === "COMPRESSED_NFT_MINT") {
    return { type: "minted", state: owner ? "owned" : "unknown" };
  }
  if (txType === "TRANSFER" || txType === "TOKEN_TRANSFER") {
    return { type: "transferred", state: owner ? "owned" : "transferred_out" };
  }
  if (txType === "BURN" || txType === "TOKEN_BURN") {
    return { type: "transferred", state: "transferred_out" };
  }
  if (txType === "NFT_PARTICIPATION_REWARD" || txType === "ATTEST") {
    return { type: "transferred", state: owner ? "owned" : "unknown" };
  }
  return null;
}

function textFromTx(tx: Record<string, unknown>) {
  return [
    tx.type,
    tx.source,
    tx.description,
    ...(Array.isArray(tx.logs) ? tx.logs : []),
    ...(Array.isArray(tx.logMessages) ? tx.logMessages : []),
    ...(Array.isArray(asRecord(tx.meta).logMessages) ? asRecord(tx.meta).logMessages : []),
    asRecord(tx.events).nft ? JSON.stringify(asRecord(tx.events).nft) : "",
  ].join(" ").toLowerCase();
}

function instructionPrograms(tx: Record<string, unknown>) {
  return (Array.isArray(tx.instructions) ? tx.instructions : [])
    .map((instruction) => asString(asRecord(instruction).programId) ?? asString(asRecord(instruction).program) ?? null)
    .filter((program): program is string => Boolean(program));
}

function accountDataAccounts(tx: Record<string, unknown>) {
  return (Array.isArray(tx.accountData) ? tx.accountData : [])
    .map((account) => asString(asRecord(account).account))
    .filter((account): account is string => Boolean(account));
}

function summarizeNativeTransfers(tx: Record<string, unknown>) {
  return (Array.isArray(tx.nativeTransfers) ? tx.nativeTransfers : []).map((transfer) => {
    const row = asRecord(transfer);
    const amount = numberFromUnknown(row.amount);
    return `${asString(row.fromUserAccount) ?? "unknown"} -> ${asString(row.toUserAccount) ?? "unknown"}:${amount ?? "?"} lamports`;
  });
}

function summarizeTokenTransfers(tx: Record<string, unknown>) {
  return (Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers : []).map((transfer) => {
    const row = asRecord(transfer);
    const amount = numberFromUnknown(row.tokenAmount);
    return `${asString(row.fromUserAccount) ?? "unknown"} -> ${asString(row.toUserAccount) ?? "unknown"}:${amount ?? "?"} ${asString(row.mint) ?? "unknown"}`;
  });
}

function summarizeNftTransfers(tx: Record<string, unknown>) {
  const eventNfts = recordArray(asRecord(asRecord(tx.events).nft).nfts);
  const nftTransfers = Array.isArray(tx.nftTransfers) ? tx.nftTransfers.map(asRecord) : [];
  return [...eventNfts, ...nftTransfers].map((transfer) => {
    const mint = asString(transfer.mint) ?? asString(transfer.assetMint) ?? "unknown";
    const from = asString(transfer.fromUserAccount) ?? asString(transfer.fromAddress) ?? "unknown";
    const to = asString(transfer.toUserAccount) ?? asString(transfer.toAddress) ?? "unknown";
    return `${mint}:${from} -> ${to}`;
  });
}

function nftTransferDetails(tx: Record<string, unknown>, mint: string) {
  const eventNfts = recordArray(asRecord(asRecord(tx.events).nft).nfts);
  const nftTransfers = Array.isArray(tx.nftTransfers) ? tx.nftTransfers.map(asRecord) : [];
  return [...eventNfts, ...nftTransfers]
    .map((transfer) => {
      const transferMint = asString(transfer.mint) ?? asString(transfer.assetMint);
      const from = asString(transfer.fromUserAccount) ?? asString(transfer.fromAddress);
      const to = asString(transfer.toUserAccount) ?? asString(transfer.toAddress);
      return { mint: transferMint, from, to };
    })
    .filter((transfer) => transfer.mint === mint);
}

function paymentLooksLikeSecondarySale(tx: Record<string, unknown>, owner: string | null) {
  if (!owner) return false;

  const outgoingNative = (Array.isArray(tx.nativeTransfers) ? tx.nativeTransfers : [])
    .map(asRecord)
    .some((transfer) => {
      const from = asString(transfer.fromUserAccount) ?? asString(transfer.fromAddress);
      const to = asString(transfer.toUserAccount) ?? asString(transfer.toAddress);
      const amount = numberFromUnknown(transfer.amount) ?? 0;
      return from === owner && to !== owner && amount > 0;
    });
  if (outgoingNative) return true;

  const outgoingToken = (Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers : [])
    .map(asRecord)
    .some((transfer) => {
      const from = asString(transfer.fromUserAccount) ?? asString(transfer.fromAddress);
      const to = asString(transfer.toUserAccount) ?? asString(transfer.toAddress);
      const amount = numberFromUnknown(transfer.tokenAmount) ?? numberFromUnknown(transfer.amount) ?? 0;
      return from === owner && to !== owner && amount > 0;
    });
  return outgoingToken;
}

function collectionMatchesPackAllowlist(collectionAddress: string | null, allowlist: string[]) {
  if (!collectionAddress) return false;
  return allowlist.includes(collectionAddress);
}

function detectKnownPackSourcePattern(tx: Record<string, unknown>) {
  const haystack = `${asString(tx.source)?.toLowerCase() ?? ""} ${asString(tx.description)?.toLowerCase() ?? ""}`;
  const patterns = ["phygital", "collector crypt", "pack opening", "open pack", "pack reveal", "pack claim"];
  return patterns.find((pattern) => haystack.includes(pattern)) ?? null;
}

function isMarketplaceSource(tx: Record<string, unknown>) {
  const source = asString(tx.source)?.toLowerCase() ?? "";
  return ["magic_eden", "magic eden", "tensor", "hyperspace", "solanart"].some((pattern) => source.includes(pattern));
}

function detectPackOpeningEvidence(tx: Record<string, unknown>, mint: string, owner: string | null, collectionAddress: string | null) {
  const config = readNftScannerConfig();
  const saleEvents = parseHeliusEnhancedTransaction(tx, { fallbackMint: mint, fallbackOwner: owner }).filter((event) => event.eventType === "SALE");
  if (saleEvents.length > 0) return { matched: false, reason: "verified sale already detected for this NFT", nftReceiver: null, matchedSignals: [], matchedAccounts: [] };

  const text = textFromTx(tx);
  const programs = instructionPrograms(tx);
  const accounts = accountDataAccounts(tx);
  const transfers = nftTransferDetails(tx, mint);
  const explicitReceiver = transfers.find((transfer) => transfer.to)?.to ?? null;
  const paymentSignal = paymentLooksLikeSecondarySale(tx, owner);

  const keywordMatches = config.packOpeningKeywords.filter((keyword) => text.includes(keyword.toLowerCase()));
  const programMatches = programs.filter((program) => config.packOpeningProgramIds.includes(program));
  const authorityMatches = accounts.filter((account) => config.packOpeningAuthorityAddresses.includes(account));
  const collectionMatched = collectionMatchesPackAllowlist(collectionAddress, config.packOpeningCollectionAddresses);
  const sourceText = `${asString(tx.source)?.toLowerCase() ?? ""} ${asString(tx.description)?.toLowerCase() ?? ""}`;
  const sourceKeywordMatch = config.packOpeningKeywords.find((keyword) => sourceText.includes(keyword.toLowerCase())) ?? null;
  const sourcePatternMatch = detectKnownPackSourcePattern(tx);
  const mintTouched = accounts.includes(mint);
  const ownerTouched = Boolean(owner && accounts.includes(owner));
  const marketplaceSource = isMarketplaceSource(tx);

  const matchedSignals = [
    ...programMatches.map((program) => `program:${program}`),
    ...authorityMatches.map((account) => `authority:${account}`),
    ...keywordMatches.map((keyword) => `keyword:${keyword}`),
    ...(collectionMatched && collectionAddress ? [`collection:${collectionAddress}`] : []),
    ...(sourceKeywordMatch ? [`source:${sourceKeywordMatch}`] : []),
    ...(sourcePatternMatch ? [`source_pattern:${sourcePatternMatch}`] : []),
  ];

  const inferredReceiver = !explicitReceiver && ownerTouched && mintTouched && matchedSignals.length > 0 ? owner : null;
  const nftReceiver = explicitReceiver ?? inferredReceiver ?? null;
  const receivedByOwner = Boolean(owner && nftReceiver === owner);
  const hasExplicitPackSignal = Boolean(
    authorityMatches.length
    || keywordMatches.length
    || sourceKeywordMatch
    || sourcePatternMatch,
  );

  if (!receivedByOwner) {
    return {
      matched: false,
      reason: "tested NFT was not received by the current owner in this transaction",
      nftReceiver,
      matchedSignals,
      matchedAccounts: authorityMatches,
    };
  }

  if (marketplaceSource && !hasExplicitPackSignal) {
    return {
      matched: false,
      reason: "marketplace source matched and only program-level pack evidence was present",
      nftReceiver,
      matchedSignals,
      matchedAccounts: authorityMatches,
    };
  }

  if (paymentSignal) {
    return {
      matched: false,
      reason: "outgoing payment pattern from current owner looks like a normal secondary sale",
      nftReceiver,
      matchedSignals,
      matchedAccounts: authorityMatches,
    };
  }

  if (matchedSignals.length === 0) {
    return {
      matched: false,
      reason: "no pack-opening allowlist signal matched",
      nftReceiver,
      matchedSignals,
      matchedAccounts: authorityMatches,
    };
  }

  return {
    matched: true,
    reason: explicitReceiver
      ? `pack-opening allowlist signal matched: ${matchedSignals.join(", ")}`
      : `pack-opening allowlist signal matched with inferred receiver from touched mint + owner: ${matchedSignals.join(", ")}`,
    nftReceiver,
    matchedSignals,
    matchedAccounts: authorityMatches,
  };
}

function inferMarketplacePurchase(tx: Record<string, unknown>, owner: string | null) {
  const source = asString(tx.source)?.toLowerCase() ?? "";
  const type = String(tx.type ?? tx.transactionType ?? "").toUpperCase();
  if (!owner || type !== "DEPOSIT") return null;
  if (!["magic_eden", "magic eden", "tensor", "hyperspace", "solanart"].some((pattern) => source.includes(pattern))) return null;

  const nativeTransfers = (Array.isArray(tx.nativeTransfers) ? tx.nativeTransfers : [])
    .map(asRecord)
    .map((transfer) => ({
      from: asString(transfer.fromUserAccount) ?? asString(transfer.fromAddress),
      to: asString(transfer.toUserAccount) ?? asString(transfer.toAddress),
      amount: numberFromUnknown(transfer.amount),
    }))
    .filter((transfer) => transfer.from && transfer.to && transfer.amount && transfer.amount > 100_000)
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));

  const ownerOutgoing = nativeTransfers.find((transfer) => transfer.from === owner && transfer.to !== owner);
  const sellerPayout = nativeTransfers.find((transfer) => transfer.from !== owner && transfer.to !== owner);
  if (!ownerOutgoing || !sellerPayout || !sellerPayout.amount) return null;

  return {
    buyer: owner,
    seller: sellerPayout.to,
    priceSol: sellerPayout.amount / 1_000_000_000,
  };
}

function hasCollectorCryptProgram(tx: Record<string, unknown>) {
  return instructionPrograms(tx).includes(COLLECTOR_CRYPT_PROGRAM_ID) || accountDataAccounts(tx).includes(COLLECTOR_CRYPT_PROGRAM_ID);
}

function hasOfferDeposit(tx: Record<string, unknown>, owner: string | null) {
  const feePayer = asString(tx.feePayer);
  const payer = owner ?? feePayer;
  return (Array.isArray(tx.nativeTransfers) ? tx.nativeTransfers : [])
    .map(asRecord)
    .some((transfer) => {
      const from = asString(transfer.fromUserAccount) ?? asString(transfer.fromAddress);
      const to = asString(transfer.toUserAccount) ?? asString(transfer.toAddress);
      const amount = numberFromUnknown(transfer.amount) ?? 0;
      return Boolean(from && to && from !== to && (!payer || from === payer) && amount > 100_000);
    });
}

function detectMakeOffer(tx: Record<string, unknown>, owner: string | null) {
  const text = textFromTx(tx);
  if (text.includes("makeoffer") || text.includes("make offer") || text.includes("instruction: makeoffer")) {
    return {
      matched: true,
      reason: "Collector Crypt MakeOffer instruction detected in transaction logs",
    };
  }

  if (hasCollectorCryptProgram(tx) && hasOfferDeposit(tx, owner)) {
    return {
      matched: true,
      reason: "Collector Crypt offer-like transaction detected from program id and SOL deposit",
    };
  }

  return { matched: false, reason: null };
}

function inferCoreTransferReceiver(tx: Record<string, unknown>, mint: string, owner: string | null, collectionAddress: string | null) {
  const feePayer = asString(tx.feePayer);
  const instructions = Array.isArray(tx.instructions) ? tx.instructions.map(asRecord) : [];
  const coreInstruction = instructions.find((instruction) => {
    const programId = asString(instruction.programId) ?? asString(instruction.program);
    if (programId !== "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d") return false;
    const accounts = Array.isArray(instruction.accounts) ? instruction.accounts.map((value) => String(value)) : [];
    return accounts.includes(mint);
  });
  if (!coreInstruction) return null;

  const accounts = Array.isArray(coreInstruction.accounts) ? coreInstruction.accounts.map((value) => String(value)) : [];
  if (collectionAddress && !accounts.includes(collectionAddress)) return null;
  if (!owner || !accounts.includes(owner)) return null;
  if (!feePayer || feePayer === owner || !accounts.includes(feePayer)) return null;

  return {
    sender: feePayer,
    receiver: owner,
    accounts,
  };
}

function detectActivityFromTx(tx: Record<string, unknown>, mint: string, owner: string | null, collectionAddress: string | null, recentTxCount = 0): {
  type: NFTLastActivityType;
  state: NFTMarketStatus;
  sale: RwaNftMarketEvent | null;
  reason: string;
  debug: {
    txHash: string | null;
    detectedType: string | null;
    currentOwner: string | null;
    nftReceiver: string | null;
    source: string | null;
    description: string | null;
    instructionPrograms: string[];
    matchedAllowlistAccounts: string[];
    matchedPackSignal: boolean;
    nativeTransfers: string[];
    tokenTransfers: string[];
    nftTransfers: string[];
  };
} {
  const sales = parseHeliusEnhancedTransaction(tx, { fallbackMint: mint, fallbackOwner: owner }).filter((event) => event.eventType === "SALE");
  const sale = sales[0] ?? null;
  const packEvidence = detectPackOpeningEvidence(tx, mint, owner, collectionAddress);
  const firstObservedMintActivity = recentTxCount > 0 && recentTxCount <= 1;
  const instructionProgramList = instructionPrograms(tx);
  const nativeTransferSummary = summarizeNativeTransfers(tx);
  const tokenTransferSummary = summarizeTokenTransfers(tx);
  const nftTransferSummary = summarizeNftTransfers(tx);
  const signature = txSignature(tx);
  const commonDebug = {
    txHash: signature,
    detectedType: String(tx.type ?? null),
    currentOwner: owner,
    nftReceiver: packEvidence.nftReceiver,
    source: asString(tx.source),
    description: asString(tx.description),
    instructionPrograms: instructionProgramList,
    matchedAllowlistAccounts: packEvidence.matchedAccounts,
    matchedPackSignal: packEvidence.matched,
    nativeTransfers: nativeTransferSummary,
    tokenTransfers: tokenTransferSummary,
    nftTransfers: nftTransferSummary,
  };
  if (sale?.txSignature) {
    const ownerIsBuyer = Boolean(owner && (sale.buyer === owner || sale.owner === owner));
    return {
      type: ownerIsBuyer ? "bought" : "sold",
      state: ownerIsBuyer ? "owned" : "sold",
      sale,
      reason: "verified sale detected by Helius enhanced transaction parser",
      debug: commonDebug,
    };
  }

  const makeOffer = detectMakeOffer(tx, owner);
  if (makeOffer.matched) {
    return {
      type: "make_offer",
      state: owner ? "owned" : "unknown",
      sale: null,
      reason: makeOffer.reason ?? "Collector Crypt MakeOffer transaction detected",
      debug: commonDebug,
    };
  }

  const inferredPurchase = inferMarketplacePurchase(tx, owner);
  if (inferredPurchase) {
    return {
      type: "bought",
      state: "owned",
      sale: null,
      reason: `marketplace deposit inferred purchase at ${inferredPurchase.priceSol} SOL`,
      debug: commonDebug,
    };
  }

  const inferredCoreTransfer = inferCoreTransferReceiver(tx, mint, owner, collectionAddress);
  if (inferredCoreTransfer) {
    if (firstObservedMintActivity && packEvidence.matched) {
      return {
        type: "pack_opened",
        state: owner ? "owned" : "unknown",
        sale: null,
        reason: `first observed mint activity matched pack-opening allowlist before any later transfer history: ${packEvidence.reason}`,
        debug: commonDebug,
      };
    }
    return {
      type: "transferred",
      state: owner ? "owned" : "transferred_out",
      sale: null,
      reason: `core transfer inferred from CoREEN instruction accounts: ${inferredCoreTransfer.sender} -> ${inferredCoreTransfer.receiver}`,
      debug: commonDebug,
    };
  }

  if (packEvidence.matched) {
    return {
      type: "pack_opened",
      state: owner ? "owned" : "unknown",
      sale: null,
      reason: packEvidence.reason,
      debug: commonDebug,
    };
  }

  // Type-first classification: trust Helius's tx.type field directly.
  // Covers cases where the sale parser misses (e.g. partial enriched data,
  // marketplaces Helius doesn't decode fully).
  const txType = String(tx.type ?? "").toUpperCase();
  const txSource = String(tx.source ?? "").toUpperCase();
  const typeClassification = classifyByHeliusType(txType, owner);
  if (typeClassification) {
    return {
      ...typeClassification,
      sale: null,
      reason: `Helius tx.type=${txType} (source=${txSource || "n/a"})`,
      debug: commonDebug,
    };
  }

  const text = textFromTx(tx);
  if (text.includes("mint")) {
    return {
      type: "minted",
      state: owner ? "owned" : "unknown",
      sale: null,
      reason: "transaction text included mint wording",
      debug: commonDebug,
    };
  }
  if (text.includes("delist") || text.includes("cancel listing") || text.includes("listing_canceled") || text.includes("listing_cancelled")) {
    return {
      type: "delisted",
      state: "unlisted",
      sale: null,
      reason: "transaction text included delist/cancel listing wording",
      debug: commonDebug,
    };
  }
  if (text.includes("sold") || text.includes("sale") || text.includes("purchase") || text.includes("bought")) {
    return {
      type: owner ? "bought" : "sold",
      state: owner ? "owned" : "sold",
      sale: null,
      reason: "transaction text included sale wording",
      debug: commonDebug,
    };
  }
  if (text.includes("bid") || text.includes("offer")) {
    return {
      type: text.includes("offer") && !text.includes("bid") ? "make_offer" : "bid",
      state: owner ? "owned" : "unknown",
      sale: null,
      reason: "transaction text included bid/offer wording",
      debug: commonDebug,
    };
  }
  if (text.includes("list")) {
    return {
      type: "listed",
      state: "listed",
      sale: null,
      reason: "transaction text included list wording",
      debug: commonDebug,
    };
  }
  if (text.includes("burn")) {
    return {
      type: "transferred",
      state: "transferred_out",
      sale: null,
      reason: "transaction text included burn wording",
      debug: commonDebug,
    };
  }
  if (text.includes("transfer") || text.includes("send")) {
    return {
      type: "transferred",
      state: owner ? "owned" : "transferred_out",
      sale: null,
      reason: `transaction text only showed transfer wording and pack evidence stayed insufficient: ${packEvidence.reason}`,
      debug: commonDebug,
    };
  }
  // Last fallback: if there are NFT transfers, treat as transferred even
  // without descriptive text.
  if (nftTransferSummary.length > 0 || tokenTransferSummary.length > 0) {
    return {
      type: "transferred",
      state: owner ? "owned" : "transferred_out",
      sale: null,
      reason: `no text match but ${nftTransferSummary.length || tokenTransferSummary.length} NFT/token transfer(s) detected on-chain`,
      debug: commonDebug,
    };
  }
  if (firstObservedMintActivity && owner && !packEvidence.matched && !paymentLooksLikeSecondarySale(tx, owner)) {
    return {
      type: "minted",
      state: "owned",
      sale: null,
      reason: "only one observed mint transaction exists and no sale, listing, transfer, or pack-opening pattern was strong enough",
      debug: commonDebug,
    };
  }
  return {
    type: "unknown",
    state: owner ? "owned" : "unknown",
    sale: null,
    reason: `no verified sale, pack-opening, mint, listing, or transfer pattern was strong enough: ${packEvidence.reason}`,
    debug: commonDebug,
  };
}

function asMarketStatus(value: unknown): NFTMarketStatus | null {
  const status = asString(value);
  if (
    status === "owned"
    || status === "unlisted"
    || status === "listed"
    || status === "sold"
    || status === "transferred_out"
    || status === "recently_sold"
    || status === "stale"
    || status === "unknown"
  ) return status;
  return null;
}

function resolveStoredActivityState(input: {
  row: SqlRow | undefined;
  detectedActivity: ReturnType<typeof detectActivityFromTx>;
  detectedAt: string | null;
  detectedTxHash: string | null;
  owner: string | null;
  activityProvider: NftActivityProviderId;
}) {
  const baseState = asMarketStatus(input.row?.current_state) ?? asMarketStatus(input.row?.current_status) ?? input.detectedActivity.state;
  if (input.detectedActivity.type !== "unknown") {
    return {
      currentState: input.detectedActivity.state,
      lastActivityType: input.detectedActivity.type,
      lastActivityAt: input.detectedAt,
      lastActivityTxHash: input.detectedTxHash,
      lastActivityProvider: input.activityProvider,
      reason: input.detectedActivity.reason,
    };
  }

  const storedActivityType = asString(input.row?.last_activity_type);
  const storedActivityAt = asString(input.row?.last_activity_at);
  const storedActivityTxHash = asString(input.row?.last_activity_tx_hash);
  const storedActivityProvider = asString(input.row?.last_activity_provider) ?? asString(input.row?.latest_provider) ?? "helius";
  const storedActivityAtMs = parseDate(storedActivityAt) ?? 0;
  const detectedAtMs = parseDate(input.detectedAt) ?? 0;

  if (storedActivityType && storedActivityType !== "unknown" && storedActivityAtMs >= detectedAtMs) {
    return {
      currentState: baseState,
      lastActivityType: storedActivityType as NFTLastActivityType,
      lastActivityAt: storedActivityAt,
      lastActivityTxHash: storedActivityTxHash ?? input.detectedTxHash,
      lastActivityProvider: storedActivityProvider,
      reason: `preserved stored activity because it is more recent or more informative than the current unknown detection (${storedActivityType})`,
    };
  }

  const hasStoredVerifiedSale = Boolean(
    asString(input.row?.last_sale_at)
    || numberFromUnknown(input.row?.last_sale_price_sol) != null
    || numberFromUnknown(input.row?.last_sale_price_usd) != null
  );
  if (hasStoredVerifiedSale) {
    const currentState = input.owner ? "owned" : "sold";
    const lastActivityType: NFTLastActivityType = input.owner ? "bought" : "sold";
    return {
      currentState,
      lastActivityType,
      lastActivityAt: asString(input.row?.last_sale_at) ?? input.detectedAt,
      lastActivityTxHash: asString(input.row?.latest_tx_hash) ?? input.detectedTxHash,
      lastActivityProvider: asString(input.row?.latest_provider) ?? asString(input.row?.last_activity_provider) ?? "helius",
      reason: `fell back to stored verified sale because market price exists without a detected current activity (${lastActivityType})`,
    };
  }

  return {
    currentState: input.detectedActivity.state,
    lastActivityType: input.detectedActivity.type,
    lastActivityAt: input.detectedAt,
    lastActivityTxHash: input.detectedTxHash,
    lastActivityProvider: input.activityProvider,
    reason: input.detectedActivity.reason,
  };
}

type ActivityDetectionResult = ReturnType<typeof detectActivityFromTx>;

type ProviderActivitySelection = {
  provider: NftActivityProviderId;
  status: NftActivityProviderResult["status"];
  txs: Record<string, unknown>[];
  signatureCount: number;
  fallbackUsed: boolean;
  dbCacheUsed: boolean;
  endpointsUsed: string[];
  fieldProviders: Record<string, string>;
  error: string | null;
};

function unknownActivity(owner: string | null, reason: string): ActivityDetectionResult {
  return {
    type: "unknown",
    state: owner ? "owned" : "unknown",
    sale: null,
    reason,
    debug: {
      ...EMPTY_ACTIVITY_DEBUG,
      currentOwner: owner,
    },
  };
}

async function fetchHeliusActivityForMint(mint: string, retries: number, fallbackUsed = false, signaturesLimit = 1): Promise<ProviderActivitySelection> {
  const limit = Math.max(1, Math.min(8, signaturesLimit));
  const signatures = await withRetries(retries, () => recentSignaturesForMint(mint, limit));
  const signatureValues = signatures.map((signature) => asString(signature.signature)).filter((signature): signature is string => Boolean(signature));
  const txs = await withRetries(retries, () => enhancedTransactions(signatureValues.slice(0, limit)));
  return {
    provider: "helius",
    status: txs.length ? "ok" : "incomplete",
    txs,
    signatureCount: signatureValues.length,
    fallbackUsed,
    dbCacheUsed: false,
    endpointsUsed: ["getSignaturesForAddress", "enhanced-transactions", "getTransaction"],
    fieldProviders: {
      lastActivity: "helius",
      latestTransaction: "helius",
      transactionDetail: "helius",
    },
    error: txs.length ? null : "Helius returned no usable activity",
  };
}

async function fetchActivityWithProviderStrategy(input: {
  mint: string;
  owner: string | null;
  collection: string | null;
  retries: number;
  useDetailedHistory: boolean;
  dbCacheAvailable: boolean;
  signaturesLimit?: number;
}): Promise<ProviderActivitySelection> {
  const strategy = getProviderStrategyConfig();
  const primary = strategy.activityPrimaryProvider === "helius" ? "helius" : "solscan";
  if (!input.useDetailedHistory) {
    logProviderStrategy({
      mint: input.mint,
      requestedDataType: "activity",
      primaryProvider: primary,
      providerCalled: "cache",
      fallbackUsed: false,
      providerStatus: "stale",
      dbCacheUsed: input.dbCacheAvailable,
    });
    return {
      provider: "cache",
      status: "stale",
      txs: [],
      signatureCount: 0,
      fallbackUsed: false,
      dbCacheUsed: input.dbCacheAvailable,
      endpointsUsed: [],
      fieldProviders: { lastActivity: "cache" },
      error: null,
    };
  }

  if (primary === "solscan") {
    const solscan = await fetchSolscanNftActivity(input.mint, primary);
    if (solscan.status === "ok") {
      return {
        provider: "solscan",
        status: "ok",
        txs: solscan.activities,
        signatureCount: solscan.activities.length,
        fallbackUsed: false,
        dbCacheUsed: false,
        endpointsUsed: solscan.endpointsUsed,
        fieldProviders: solscan.fieldProviders,
        error: null,
      };
    }

    if (strategy.fallbackEnabled && hasHeliusApiKey()) {
      logProviderStrategy({
        mint: input.mint,
        requestedDataType: "activity",
        primaryProvider: primary,
        providerCalled: "helius",
        fallbackUsed: true,
        providerStatus: "fallback_from_solscan",
        dbCacheUsed: false,
      });
      try {
        return await fetchHeliusActivityForMint(input.mint, input.retries, true, input.signaturesLimit);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Helius activity fallback failed";
        logProviderStrategy({
          mint: input.mint,
          requestedDataType: "activity",
          primaryProvider: primary,
          providerCalled: "cache",
          fallbackUsed: true,
          providerStatus: "stale",
          dbCacheUsed: input.dbCacheAvailable,
        });
        return {
          provider: input.dbCacheAvailable ? "cache" : "solscan",
          status: input.dbCacheAvailable ? "stale" : "error",
          txs: solscan.activities,
          signatureCount: solscan.activities.length,
          fallbackUsed: true,
          dbCacheUsed: input.dbCacheAvailable,
          endpointsUsed: solscan.endpointsUsed,
          fieldProviders: input.dbCacheAvailable ? { lastActivity: "cache" } : solscan.fieldProviders,
          error: `${solscan.error ?? "Solscan incomplete"}; ${message}`,
        };
      }
    }

    return {
      provider: input.dbCacheAvailable ? "cache" : "solscan",
      status: input.dbCacheAvailable ? "stale" : solscan.status,
      txs: solscan.activities,
      signatureCount: solscan.activities.length,
      fallbackUsed: false,
      dbCacheUsed: input.dbCacheAvailable,
      endpointsUsed: solscan.endpointsUsed,
      fieldProviders: input.dbCacheAvailable ? { lastActivity: "cache" } : solscan.fieldProviders,
      error: solscan.error,
    };
  }

  try {
    return await fetchHeliusActivityForMint(input.mint, input.retries, false, input.signaturesLimit);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Helius activity failed";
    if (strategy.fallbackEnabled) {
      const solscan = await fetchSolscanNftActivity(input.mint, primary);
      return {
        provider: solscan.status === "ok" ? "solscan" : input.dbCacheAvailable ? "cache" : "solscan",
        status: solscan.status === "ok" ? "ok" : input.dbCacheAvailable ? "stale" : solscan.status,
        txs: solscan.activities,
        signatureCount: solscan.activities.length,
        fallbackUsed: true,
        dbCacheUsed: solscan.status !== "ok" && input.dbCacheAvailable,
        endpointsUsed: solscan.endpointsUsed,
        fieldProviders: solscan.status === "ok" ? solscan.fieldProviders : input.dbCacheAvailable ? { lastActivity: "cache" } : solscan.fieldProviders,
        error: solscan.status === "ok" ? null : `${message}; ${solscan.error ?? "Solscan incomplete"}`,
      };
    }
    return {
      provider: input.dbCacheAvailable ? "cache" : "helius",
      status: input.dbCacheAvailable ? "stale" : "error",
      txs: [],
      signatureCount: 0,
      fallbackUsed: false,
      dbCacheUsed: input.dbCacheAvailable,
      endpointsUsed: [],
      fieldProviders: input.dbCacheAvailable ? { lastActivity: "cache" } : { lastActivity: "helius" },
      error: message,
    };
  }
}

function metadataStatus(input: { name: string | null; image: string | null; owner: string | null }): NFTMetadataStatus {
  const complete = Boolean(input.name && input.image && input.owner);
  if (complete) return "complete";
  if (input.name || input.image || input.owner) return "partial";
  return "missing";
}

function shouldReplaceCategory(row: SqlRow, detected: string) {
  return isAllowedRwaNftCategory(detected) && (!asString(row.category) || row.category === "unknown");
}

function shouldReplaceAssetType(row: SqlRow, detected: string) {
  return detected !== "unknown" && (!asString(row.asset_type) || row.asset_type === "unknown");
}

async function withRetries<T>(retries: number, action: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("NFT enrichment failed");
}

function updateAssetFromEnrichment(input: {
  row: SqlRow;
  normalized: ReturnType<typeof normalizeHeliusAsset>;
  rawAsset: unknown;
  metadataProvider: MetadataProviderId;
  fieldProviders: Record<string, string>;
  currentState: NFTMarketStatus;
  lastActivityType: NFTLastActivityType;
  lastActivityAt: string | null;
  lastActivityTxHash: string | null;
  lastActivityProvider: string;
  sale: RwaNftMarketEvent | null;
  metadataStatus: NFTMetadataStatus;
}) {
  const now = nowIso();
  const detectedCategory = detectRwaNftCategory({
    name: input.normalized.name,
    description: input.normalized.description,
    collection: input.normalized.collection,
    attributes: input.normalized.attributes,
  });
  const detectedAssetType = detectCollectibleAssetType({
    name: input.normalized.name,
    description: input.normalized.description,
    collection: input.normalized.collection,
    attributes: input.normalized.attributes,
    raw: input.rawAsset,
  });
  const publicGroup = publicGroupForAssetType(detectedAssetType);
  const replaceCategory = shouldReplaceCategory(input.row, detectedCategory);
  const replaceAssetType = shouldReplaceAssetType(input.row, detectedAssetType);

  getNftDb().prepare(`
    UPDATE nft_assets SET
      name = CASE WHEN name IS NULL OR name = '' OR name = '- NULL -' THEN COALESCE(?, name) ELSE name END,
      description = CASE WHEN description IS NULL OR description = '' THEN COALESCE(?, description) ELSE description END,
      image = CASE WHEN image IS NULL OR image = '' THEN COALESCE(?, image) ELSE image END,
      owner = COALESCE(?, owner),
      collection = COALESCE(collection, ?),
      category = CASE WHEN ? = 1 THEN ? ELSE category END,
      asset_type = CASE WHEN ? = 1 THEN ? ELSE asset_type END,
      public_group = CASE WHEN ? = 1 THEN ? ELSE public_group END,
      attributes_json = CASE WHEN attributes_json IS NULL OR attributes_json = '[]' THEN ? ELSE attributes_json END,
      token_standard = COALESCE(token_standard, ?),
      interface = COALESCE(interface, ?),
      source_collection = COALESCE(source_collection, ?),
      source_provider = COALESCE(source_provider, ?),
      current_state = ?,
      current_status = ?,
      last_activity_type = ?,
      last_activity_at = ?,
      last_activity_tx_hash = ?,
      last_activity_provider = ?,
      latest_provider = COALESCE(latest_provider, ?),
      latest_tx_hash = COALESCE(?, latest_tx_hash),
      latest_market_price_sol = COALESCE(latest_market_price_sol, ?),
      latest_market_price_usd = COALESCE(latest_market_price_usd, ?),
      latest_purchase_price_sol = COALESCE(latest_purchase_price_sol, ?),
      latest_purchase_price_usd = COALESCE(latest_purchase_price_usd, ?),
      metadata_status = ?,
      validation_status = ?,
      raw_helius_json = CASE WHEN ? = 1 THEN ? ELSE raw_helius_json END,
      raw_market_state_json = ?,
      last_checked_at = ?,
      last_seen_at = ?,
      market_updated_at = ?,
      updated_at = ?
    WHERE mint = ?
  `).run(
    input.normalized.name,
    input.normalized.description,
    input.normalized.image,
    input.normalized.owner,
    input.normalized.collection,
    sqliteBool(replaceCategory),
    detectedCategory,
    sqliteBool(replaceAssetType),
    detectedAssetType,
    sqliteBool(replaceAssetType),
    publicGroup,
    stringifyJson(input.normalized.attributes),
    input.normalized.tokenStandard,
    input.normalized.interface,
    input.normalized.collection,
    input.metadataProvider,
    input.currentState,
    input.currentState,
    input.lastActivityType,
    input.lastActivityAt,
    input.lastActivityTxHash,
    input.lastActivityProvider,
    input.lastActivityProvider,
    input.lastActivityTxHash,
    input.sale?.priceSol ?? null,
    input.sale?.priceUsd ?? null,
    input.sale?.priceSol ?? null,
    input.sale?.priceUsd ?? null,
    input.metadataStatus,
    input.sale?.txSignature ? "verified" : "unverified",
    sqliteBool(shouldStoreRawHeliusJson()),
    shouldStoreRawHeliusJson() ? stringifyJson(input.rawAsset) : null,
    stringifyJson({
      provider: input.lastActivityProvider,
      metadataProvider: input.metadataProvider,
      fieldProviders: input.fieldProviders,
      lastActivityType: input.lastActivityType,
      lastActivityAt: input.lastActivityAt,
      latestMarketPricePriority: input.sale?.txSignature ? "verified_sale" : "unknown",
    }),
    now,
    now,
    now,
    now,
    input.normalized.mint,
  );
}

function buildChange(input: {
  row: SqlRow;
  normalized: ReturnType<typeof normalizeHeliusAsset>;
  currentState: NFTMarketStatus;
  lastActivityType: NFTLastActivityType;
  lastActivityAt: string | null;
  lastActivityTxHash: string | null;
  metadataStatus: NFTMetadataStatus;
  detectedCategory: string;
  detectedAssetType: string;
}): EnrichedNftChange {
  return {
    mint: input.normalized.mint,
    nameUpdated: isMissingText(input.row.name) && Boolean(input.normalized.name),
    imageUpdated: isMissingText(input.row.image) && Boolean(input.normalized.image),
    ownerUpdated: asString(input.row.owner) !== input.normalized.owner && Boolean(input.normalized.owner),
    assetTypeUpdated: shouldReplaceAssetType(input.row, input.detectedAssetType),
    categoryUpdated: shouldReplaceCategory(input.row, input.detectedCategory),
    lastActivityUpdated: asString(input.row.last_activity_tx_hash) !== input.lastActivityTxHash || asString(input.row.last_activity_type) !== input.lastActivityType,
    providerUpdated: !asString(input.row.latest_provider),
    metadataStatus: input.metadataStatus,
    currentState: input.currentState,
    lastActivityType: input.lastActivityType,
    lastActivityAt: input.lastActivityAt,
    lastActivityTxHash: input.lastActivityTxHash,
  };
}

function statusFromRun(input: {
  startedAt: string;
  durationMs: number;
  checked: number;
  found: number;
  stored: number;
  errors: number;
  metadataUpdated: number;
  imagesUpdated: number;
  ownersUpdated: number;
  lastActivitiesUpdated: number;
}): ProviderScanStatus {
  const strategy = getProviderStrategyConfig();
  const providerName = strategy.activityPrimaryProvider === "solscan"
    ? `mixed-${hasShyftApiKey() ? "shyft-" : ""}${hasHeliusApiKey() ? "helius-" : ""}solscan`
    : "helius";
  return {
    provider: providerName.replace(/-$/, ""),
    scanType: "market_state",
    status: hasHeliusApiKey() ? input.errors ? "error" : "live" : "needs_api_key",
    lastRunAt: input.startedAt,
    lastSuccessAt: input.errors || !hasHeliusApiKey() ? null : nowIso(),
    lastError: !hasHeliusApiKey() ? "Missing HELIUS_API_KEY for metadata/DAS fallback" : input.errors ? `${input.errors} NFT(s) failed` : null,
    itemsChecked: input.checked,
    itemsFound: input.found,
    itemsStored: input.stored,
    durationMs: input.durationMs,
    metadataUpdated: input.metadataUpdated,
    imagesUpdated: input.imagesUpdated,
    ownersUpdated: input.ownersUpdated,
    lastActivitiesUpdated: input.lastActivitiesUpdated,
  };
}

export type RefreshNftByMintOptions = {
  mint: string;
  refresh?: boolean | null;
  dryRun?: boolean | null;
  /** Skip transaction-history fetching. Only 1 Helius DAS call per NFT + marketplace listing lookup. */
  listingOnly?: boolean | null;
};

export type RefreshNftByMintResult = {
  nft: ReturnType<typeof rowToNftDto> | null;
  cacheHit: boolean;
  heliusCalled: boolean;
  dbUpdated: boolean;
  providerUsed: string | null;
  reason: string;
  verifiedSalesDetected: number;
  verifiedSalesStored: number;
  error: string | null;
};

async function insertAssetPlaceholderIfMissing(mint: string, market: string, normalized: ReturnType<typeof normalizeHeliusAsset>, metadataStatusValue: NFTMetadataStatus) {
  const now = nowIso();
  getNftDb().prepare(`
    INSERT OR IGNORE INTO nft_assets (
      id, mint, market, name, description, image, owner, collection, category, asset_type, public_group,
      attributes_json, token_standard, interface, source_collection, is_staging, raw_helius_json,
      current_state, current_status, last_activity_type, last_activity_at, last_activity_tx_hash, last_activity_provider,
      latest_provider, latest_tx_hash, latest_market_price_sol, latest_market_price_usd, latest_purchase_price_sol,
      latest_purchase_price_usd, metadata_status, validation_status, raw_market_state_json, last_checked_at,
      last_seen_at, market_updated_at, updated_at, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, 0, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    mint,
    mint,
    market,
    normalized.name,
    normalized.description,
    normalized.image,
    normalized.owner,
    normalized.collection,
    "unknown",
    "unknown",
    "other",
    stringifyJson(normalized.attributes),
    normalized.tokenStandard,
    normalized.interface,
    normalized.collection,
    shouldStoreRawHeliusJson() ? stringifyJson({ source: "helius", mint }) : null,
    normalized.owner ? "owned" : "unknown",
    normalized.owner ? "owned" : "unknown",
    "unknown",
    null,
    null,
    "helius",
    "helius",
    null,
    null,
    null,
    null,
    metadataStatusValue,
    "unverified",
    stringifyJson({ source: "helius", mode: "placeholder" }),
    now,
    now,
    now,
    now,
    now,
  );
}

function isFreshEnough(row: SqlRow | undefined, ttlSeconds: number) {
  if (!row) return false;
  const checkedAt = parseDate(row.last_checked_at);
  if (!checkedAt) return false;
  return Date.now() - checkedAt <= ttlSeconds * 1000;
}

function buildRefreshReason(row: SqlRow | undefined, ttlSeconds: number) {
  if (!row) return "cache miss";
  if (rowNeedsRefresh(row, ttlSeconds)) return "stale or incomplete";
  return "fresh enough";
}

function mergeEnrichmentPreview(row: SqlRow | undefined, normalized: ReturnType<typeof normalizeHeliusAsset>, activity: ReturnType<typeof detectActivityFromTx>, metadata: NFTMetadataStatus, currentState: NFTMarketStatus, lastActivityType: NFTLastActivityType, lastActivityAt: string | null, lastActivityTxHash: string | null, lastActivityProvider: string) {
  const detectedCategory = detectRwaNftCategory({
    name: normalized.name,
    description: normalized.description,
    collection: normalized.collection,
    attributes: normalized.attributes,
  });
  const detectedAssetType = detectCollectibleAssetType({
    name: normalized.name,
    description: normalized.description,
    collection: normalized.collection,
    attributes: normalized.attributes,
    raw: normalized,
  });
  const base = row ?? { mint: normalized.mint, market: isAllowedRwaNftCategory(detectedCategory) ? detectedCategory : "unknown" };
  const next: Record<string, unknown> = {
    ...base,
    mint: normalized.mint,
    market: asString(base.market) ?? (isAllowedRwaNftCategory(detectedCategory) ? detectedCategory : "unknown"),
    name: isMissingText(base.name) && normalized.name ? normalized.name : base.name ?? normalized.name ?? null,
    description: isMissingText(base.description) && normalized.description ? normalized.description : base.description ?? normalized.description ?? null,
    image: isMissingText(base.image) && normalized.image ? normalized.image : base.image ?? normalized.image ?? null,
    owner: normalized.owner ?? asString(base.owner),
    collection: asString(base.collection) ?? normalized.collection,
    collection_name: asString(base.collection_name) ?? normalized.collection,
    category: isAllowedRwaNftCategory(detectedCategory) && (!asString(base.category) || asString(base.category) === "unknown") ? detectedCategory : asString(base.category) ?? "unknown",
    asset_type: detectedAssetType !== "unknown" && (!asString(base.asset_type) || asString(base.asset_type) === "unknown") ? detectedAssetType : asString(base.asset_type) ?? "unknown",
    public_group: detectedAssetType !== "unknown" ? publicGroupForAssetType(detectedAssetType) : asString(base.public_group) ?? "other",
    attributes_json: stringifyJson(normalized.attributes),
    token_standard: asString(base.token_standard) ?? normalized.tokenStandard,
    interface: asString(base.interface) ?? normalized.interface,
    source_collection: asString(base.source_collection) ?? normalized.collection,
    source_provider: asString(base.source_provider) ?? "helius",
    current_state: currentState,
    current_status: currentState,
    last_activity_type: lastActivityType,
    last_activity_at: lastActivityAt,
    last_activity_tx_hash: lastActivityTxHash ?? asString(base.last_activity_tx_hash),
    last_activity_provider: lastActivityProvider,
    latest_provider: "helius",
    latest_tx_hash: activity.sale?.txSignature ?? asString(base.latest_tx_hash),
    latest_market_price_sol: activity.sale?.priceSol ?? (typeof base.latest_market_price_sol === "number" ? base.latest_market_price_sol : null),
    latest_market_price_usd: activity.sale?.priceUsd ?? (typeof base.latest_market_price_usd === "number" ? base.latest_market_price_usd : null),
    latest_purchase_price_sol: activity.sale?.priceSol ?? (typeof base.latest_purchase_price_sol === "number" ? base.latest_purchase_price_sol : null),
    latest_purchase_price_usd: activity.sale?.priceUsd ?? (typeof base.latest_purchase_price_usd === "number" ? base.latest_purchase_price_usd : null),
    metadata_status: metadata,
    validation_status: activity.sale?.txSignature ? "verified" : asString(base.validation_status) ?? "unverified",
    raw_market_state_json: stringifyJson({
      provider: "helius",
      lastActivityType,
      lastActivityAt,
      latestMarketPricePriority: activity.sale?.txSignature ? "verified_sale" : "unknown",
    }),
    last_checked_at: nowIso(),
    last_seen_at: nowIso(),
    market_updated_at: nowIso(),
    updated_at: nowIso(),
  };
  return next as SqlRow;
}

type DerivedListingMarketState = {
  currentState: NFTMarketStatus;
  lastActivityType: NFTLastActivityType;
  lastActivityAt: string | null;
  lastActivityProvider: string;
  latestProvider: string;
  latestMarketplace: string | null;
  latestMarketPriceSol: number | null;
  latestMarketPriceUsd: number | null;
  isListed: boolean;
  listedPriceSol: number | null;
  listedPriceUsd: number | null;
  listingMarketplace: string | null;
  listingUpdatedAt: string | null;
  rawMarketStateJson: string;
  /** Verification status from the marketplace lookup. Controls whether is_listed is written. */
  listingVerificationStatus: import("./nftMarketplaceListingService").ListingVerificationStatus;
};

function deriveListingMarketState(input: {
  row: SqlRow;
  currentState: NFTMarketStatus;
  lastActivityType: NFTLastActivityType;
  lastActivityAt: string | null;
  lastActivityProvider: string;
  sale: RwaNftMarketEvent | null;
  listingResult: ActiveMintListingLookupResult | null;
  fieldProviders?: Record<string, string>;
}) : DerivedListingMarketState {
  const listing = input.listingResult?.listing ?? null;
  const hasListing = Boolean(input.listingResult?.found && listing);
  const listingAt = hasListing ? (listing?.listedAt ?? null) : null;
  const listingIsNewer = hasListing && Boolean(listingAt) && ((parseDate(listingAt) ?? 0) >= (parseDate(input.lastActivityAt) ?? 0));
  const currentState = hasListing
    ? "listed"
    : input.currentState === "listed"
      ? "owned"
      : input.currentState;
  const lastActivityType = hasListing && listingIsNewer ? "listed" : input.lastActivityType;
  const lastActivityAt = hasListing && listingIsNewer ? (listingAt ?? input.lastActivityAt) : input.lastActivityAt;
  const lastActivityProvider = hasListing && listingIsNewer ? listing!.providerId : input.lastActivityProvider;
  const latestProvider = input.sale?.txSignature ? "helius" : hasListing ? listing!.providerId : asString(input.row.latest_provider) ?? input.lastActivityProvider;
  const latestMarketplace = input.sale?.marketplace ?? (hasListing ? listing!.marketplace : asString(input.row.latest_marketplace));
  const latestMarketPriceSol =
    input.sale?.priceSol
    ?? (typeof input.row.latest_market_price_sol === "number" ? input.row.latest_market_price_sol : null)
    ?? (hasListing ? listing!.priceSol : null);
  const latestMarketPriceUsd =
    input.sale?.priceUsd
    ?? (typeof input.row.latest_market_price_usd === "number" ? input.row.latest_market_price_usd : null)
    ?? (hasListing ? listing!.priceUsd : null);

  return {
    currentState,
    lastActivityType,
    lastActivityAt,
    lastActivityProvider,
    latestProvider,
    latestMarketplace,
    latestMarketPriceSol,
    latestMarketPriceUsd,
    isListed: hasListing,
    listedPriceSol: hasListing ? listing!.priceSol : null,
    listedPriceUsd: hasListing ? listing!.priceUsd : null,
    listingMarketplace: hasListing ? listing!.marketplace : null,
    listingUpdatedAt: hasListing ? listingAt : null,
    listingVerificationStatus: input.listingResult?.verificationStatus ?? "unknown",
    rawMarketStateJson: stringifyJson({
      provider: latestProvider,
      activeListing: hasListing ? {
        providerId: listing!.providerId,
        marketplace: listing!.marketplace,
        priceSol: listing!.priceSol,
        priceUsd: listing!.priceUsd,
        listedAt: listingAt,
      } : null,
      lastActivityType,
      lastActivityAt,
      fieldProviders: input.fieldProviders ?? {},
      latestMarketPricePriority: input.sale?.txSignature ? "verified_sale" : hasListing ? "active_listing" : "unknown",
      listingProvidersChecked: input.listingResult?.providersChecked ?? [],
    }),
  };
}

function applyListingMarketStateToPreviewRow(row: SqlRow, marketState: DerivedListingMarketState) {
  return {
    ...row,
    is_listed: marketState.isListed,
    listed_price_sol: marketState.listedPriceSol,
    listed_price_usd: marketState.listedPriceUsd,
    listing_marketplace: marketState.listingMarketplace,
    listing_updated_at: marketState.listingUpdatedAt,
    current_state: marketState.currentState,
    current_status: marketState.currentState,
    last_activity_type: marketState.lastActivityType,
    last_activity_at: marketState.lastActivityAt,
    last_activity_provider: marketState.lastActivityProvider,
    latest_provider: marketState.latestProvider,
    latest_marketplace: marketState.latestMarketplace,
    latest_market_price_sol: marketState.latestMarketPriceSol,
    latest_market_price_usd: marketState.latestMarketPriceUsd,
    raw_market_state_json: marketState.rawMarketStateJson,
    market_updated_at: nowIso(),
    updated_at: nowIso(),
  } as SqlRow;
}

function persistListingMarketState(mint: string, marketState: DerivedListingMarketState) {
  const timestamp = nowIso();
  const vs = marketState.listingVerificationStatus;
  // When providers are unavailable no actual marketplace check ran.
  // Preserve whatever is_listed value is already in the DB instead of overwriting with 0.
  const providerUnavailable = vs === "provider_unavailable" || vs === "unknown";
  const checkedAt = providerUnavailable ? null : timestamp;

  if (providerUnavailable) {
    // Partial update: write activity/state fields but leave is_listed and listing fields intact.
    getNftDb().prepare(`
      UPDATE nft_assets SET
        current_state = ?,
        current_status = ?,
        last_activity_type = ?,
        last_activity_at = ?,
        last_activity_provider = ?,
        latest_provider = ?,
        latest_marketplace = ?,
        latest_market_price_sol = ?,
        latest_market_price_usd = ?,
        listing_verification_status = ?,
        raw_market_state_json = ?,
        market_updated_at = ?,
        updated_at = ?
      WHERE mint = ?
    `).run(
      marketState.currentState,
      marketState.currentState,
      marketState.lastActivityType,
      marketState.lastActivityAt,
      marketState.lastActivityProvider,
      marketState.latestProvider,
      marketState.latestMarketplace,
      marketState.latestMarketPriceSol,
      marketState.latestMarketPriceUsd,
      vs,
      marketState.rawMarketStateJson,
      timestamp,
      timestamp,
      mint,
    );
  } else {
    // Full update: a provider actually ran — safe to write is_listed.
    getNftDb().prepare(`
      UPDATE nft_assets SET
        is_listed = ?,
        listed_price_sol = ?,
        listed_price_usd = ?,
        listing_marketplace = ?,
        listing_updated_at = ?,
        current_state = ?,
        current_status = ?,
        last_activity_type = ?,
        last_activity_at = ?,
        last_activity_provider = ?,
        latest_provider = ?,
        latest_marketplace = ?,
        latest_market_price_sol = ?,
        latest_market_price_usd = ?,
        listing_verification_status = ?,
        last_listing_checked_at = ?,
        raw_market_state_json = ?,
        market_updated_at = ?,
        updated_at = ?
      WHERE mint = ?
    `).run(
      sqliteBool(marketState.isListed),
      marketState.listedPriceSol,
      marketState.listedPriceUsd,
      marketState.listingMarketplace,
      marketState.listingUpdatedAt,
      marketState.currentState,
      marketState.currentState,
      marketState.lastActivityType,
      marketState.lastActivityAt,
      marketState.lastActivityProvider,
      marketState.latestProvider,
      marketState.latestMarketplace,
      marketState.latestMarketPriceSol,
      marketState.latestMarketPriceUsd,
      vs,
      checkedAt,
      marketState.rawMarketStateJson,
      timestamp,
      timestamp,
      mint,
    );
  }
}

export async function refreshNftByMint(options: RefreshNftByMintOptions): Promise<RefreshNftByMintResult> {
  const mint = options.mint.trim();
  if (!mint) {
    return {
      nft: null,
      cacheHit: false,
      heliusCalled: false,
      dbUpdated: false,
      providerUsed: null,
      reason: "missing mint",
      verifiedSalesDetected: 0,
      verifiedSalesStored: 0,
      error: "Missing mint",
    };
  }

  const config = readNftScannerConfig({ dryRun: options.dryRun });
  const dryRun = config.nftListEnrichDryRun;
  const row = loadAssetByMint(mint);
  const cacheHit = Boolean(row) && !options.refresh && isFreshEnough(row, config.nftListEnrichTtlSeconds) && rowMetadataStatus(row ?? {}) === "complete";
  const forceRefreshRequested = options.refresh === true;
  const shouldRefresh = !cacheHit && (forceRefreshRequested || rowNeedsRefresh(row, config.nftListEnrichTtlSeconds) || !row);
  const cooldownActive = refreshCooldownActive(row, config.nftListEnrichRefreshCooldownSeconds);

  console.log(`[NFT LOOKUP] searched mint=${mint}`);
  console.log(`[NFT LOOKUP] cache=${row ? "hit" : "miss"} fresh=${row ? isFreshEnough(row, config.nftListEnrichTtlSeconds) : false} complete=${row ? rowMetadataStatus(row) : "missing"}`);

  if (row && cacheHit) {
    console.log("[NFT LOOKUP] Helius skipped: cached NFT is fresh enough");
    return {
      nft: rowToNftDto(row),
      cacheHit: true,
      heliusCalled: false,
      dbUpdated: false,
      providerUsed: asString(row.source_provider) ?? asString(row.latest_provider) ?? null,
      reason: "fresh cache hit",
      verifiedSalesDetected: 0,
      verifiedSalesStored: 0,
      error: null,
    };
  }

  if (row && forceRefreshRequested && cooldownActive) {
    console.log("[NFT LOOKUP] Helius cooldown bypassed: force refresh requested");
  }

  if (!shouldRefresh && row) {
    console.log("[NFT LOOKUP] Helius skipped: existing NFT does not need refresh");
    return {
      nft: rowToNftDto(row),
      cacheHit: true,
      heliusCalled: false,
      dbUpdated: false,
      providerUsed: asString(row.source_provider) ?? asString(row.latest_provider) ?? null,
      reason: "not stale",
      verifiedSalesDetected: 0,
      verifiedSalesStored: 0,
      error: null,
    };
  }

  console.log(`[NFT LOOKUP] Helius called: ${row ? "stale/incomplete" : "missing"}`);

  let verifiedSalesDetected = 0;
  let verifiedSalesStored = 0;
  let dbUpdated = false;
  try {
    const metadataResult = await loadMetadataForMint({
      mint,
      row,
      market: asString(row?.market) ?? asString(row?.category) ?? "unknown",
      retries: config.nftListEnrichMaxRetries,
    });
    const { rawAsset, normalized } = metadataResult;
    const metadataProvider: MetadataProviderId = metadataResult.metadataProvider;
    const metadata = metadataStatus({ name: normalized.name, image: normalized.image, owner: normalized.owner });
    const listingOnly = options.listingOnly === true;
    const activitySelection = await fetchActivityWithProviderStrategy({
      mint,
      owner: normalized.owner,
      collection: normalized.collection,
      retries: config.nftListEnrichMaxRetries,
      useDetailedHistory: !listingOnly,
      dbCacheAvailable: Boolean(row),
      signaturesLimit: config.nftListEnrichSignaturesLimit,
    });
    const txs = activitySelection.txs;
    const latestTx = txs[0] ?? null;
    const activity = latestTx
      ? detectActivityFromTx(latestTx, mint, normalized.owner, normalized.collection, activitySelection.signatureCount)
      : unknownActivity(normalized.owner, listingOnly ? "listing-only mode: tx history skipped" : activitySelection.dbCacheUsed ? "provider unavailable, preserved cached activity when possible" : "no recent transaction found");
    const verifiedSale = activitySelection.provider === "helius" ? activity.sale : null;
    const detectedLastActivityAt = latestTx ? timestampFromTx(latestTx) : null;
    const detectedLastActivityTxHash = latestTx ? txSignature(latestTx) : null;
    const resolvedActivity = resolveStoredActivityState({
      row,
      detectedActivity: activity,
      detectedAt: detectedLastActivityAt,
      detectedTxHash: detectedLastActivityTxHash,
      owner: normalized.owner,
      activityProvider: activitySelection.provider,
    });
    const lastActivityAt = resolvedActivity.lastActivityAt;
    const lastActivityTxHash = resolvedActivity.lastActivityTxHash;
    const detectedCategory = detectRwaNftCategory({
      name: normalized.name,
      description: normalized.description,
      collection: normalized.collection,
      attributes: normalized.attributes,
    });
    const detectedAssetType = detectCollectibleAssetType({
      name: normalized.name,
      description: normalized.description,
      collection: normalized.collection,
      attributes: normalized.attributes,
      raw: rawAsset,
    });

    if (latestTx) {
      console.log(`[NFT LOOKUP][DEBUG] mint=${mint} txHash=${activity.debug.txHash ?? "unknown"} currentOwner=${activity.debug.currentOwner ?? "unknown"} nftReceiver=${activity.debug.nftReceiver ?? "unknown"}`);
      console.log(`[NFT LOOKUP][DEBUG] txType=${activity.debug.detectedType ?? "unknown"} source=${activity.debug.source ?? "unknown"} description=${activity.debug.description ?? "unknown"}`);
      console.log(`[NFT LOOKUP][DEBUG] instructionPrograms=${activity.debug.instructionPrograms.length ? activity.debug.instructionPrograms.join(", ") : "none"}`);
      console.log(`[NFT LOOKUP][DEBUG] allowlistAccounts=${activity.debug.matchedAllowlistAccounts.length ? activity.debug.matchedAllowlistAccounts.join(", ") : "none"} matchedPackSignal=${activity.debug.matchedPackSignal}`);
      console.log(`[NFT LOOKUP][DEBUG] nativeTransfers=${activity.debug.nativeTransfers.length ? activity.debug.nativeTransfers.join(" | ") : "none"}`);
      console.log(`[NFT LOOKUP][DEBUG] tokenTransfers=${activity.debug.tokenTransfers.length ? activity.debug.tokenTransfers.join(" | ") : "none"}`);
      console.log(`[NFT LOOKUP][DEBUG] nftTransfers=${activity.debug.nftTransfers.length ? activity.debug.nftTransfers.join(" | ") : "none"}`);
      console.log(`[NFT LOOKUP][DEBUG] reason=${activity.reason}`);
      if (resolvedActivity.reason !== activity.reason) console.log(`[NFT LOOKUP][DEBUG] resolvedReason=${resolvedActivity.reason}`);
    }

    if (verifiedSale?.txSignature) {
      verifiedSalesDetected += 1;
    }

    console.log(`[NFT LOOKUP] active listing refresh started mint=${mint}`);
    let listingResult: ActiveMintListingLookupResult | null = null;
    try {
      listingResult = await lookupActiveListingByMint(mint);
      console.log(`[NFT LOOKUP] providers checked=${listingResult.providersChecked.length ? listingResult.providersChecked.map((check) => `${check.providerId}:${check.status}`).join(", ") : "none"}`);
      console.log(`[NFT LOOKUP] listing found=${listingResult.found}`);
      if (listingResult.listing) {
        const price = listingResult.listing.priceSol != null
          ? `${listingResult.listing.priceSol} SOL`
          : listingResult.listing.priceUsd != null
            ? `${listingResult.listing.priceUsd} USD`
            : "unknown";
        console.log(`[NFT LOOKUP] listing price=${price}`);
      }
    } catch (error) {
      console.log(`[NFT LOOKUP] listing lookup failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    const market = row?.market && asString(row.market) ? asString(row.market) : isAllowedRwaNftCategory(detectedCategory) ? detectedCategory : "unknown";
    const previewBaseRow = mergeEnrichmentPreview(row, normalized, { ...activity, sale: verifiedSale }, metadata, resolvedActivity.currentState, resolvedActivity.lastActivityType, lastActivityAt, lastActivityTxHash, resolvedActivity.lastActivityProvider);
    const listingMarketState = deriveListingMarketState({
      row: previewBaseRow,
      currentState: resolvedActivity.currentState,
      lastActivityType: resolvedActivity.lastActivityType,
      lastActivityAt,
      lastActivityProvider: resolvedActivity.lastActivityProvider,
      sale: verifiedSale,
      listingResult,
      fieldProviders: {
        metadata: metadataProvider,
        image: metadataProvider,
        owner: metadataProvider,
        collection: metadataProvider,
        assetType: metadataProvider,
        ...activitySelection.fieldProviders,
        ...(listingResult?.found ? { activeListing: listingResult.listing?.providerId ?? "marketplace" } : {}),
      },
    });
    const previewRow = applyListingMarketStateToPreviewRow(previewBaseRow, listingMarketState);
    console.log(`[NFT LOOKUP] final state=${listingMarketState.currentState}`);

    if (dryRun) {
      console.log(`[NFT LOOKUP][DRY RUN] ${mint} state=${listingMarketState.currentState} lastActivity=${listingMarketState.lastActivityType} tx=${lastActivityTxHash ?? "none"}`);
      return {
      nft: rowToNftDto(previewRow),
      cacheHit: false,
      heliusCalled: true,
      dbUpdated: false,
      providerUsed: [metadataProvider, activitySelection.provider].filter(Boolean).join("+"),
      reason: listingResult?.reason ?? activity.reason,
        verifiedSalesDetected,
        verifiedSalesStored: 0,
        error: null,
      };
    }

    if (!row) {
      insertAssetPlaceholderIfMissing(mint, market, normalized, metadata);
    }

    if (verifiedSale?.txSignature) {
      const category = verifiedSale.category ?? (isAllowedRwaNftCategory(detectedCategory) ? detectedCategory : asString(row?.category));
      const result = await saveRwaNftMarketEvent({ ...verifiedSale, category });
      if (result.saved) verifiedSalesStored += 1;
    }

    updateAssetFromEnrichment({
      row: row ?? mergePreviewRow(null, { mint, market, category: market, asset_type: "unknown", public_group: "other" }),
      normalized,
      rawAsset,
      metadataProvider,
      fieldProviders: {
        metadata: metadataProvider,
        image: metadataProvider,
        owner: metadataProvider,
        collection: metadataProvider,
        assetType: metadataProvider,
        ...activitySelection.fieldProviders,
      },
      currentState: listingMarketState.currentState,
      lastActivityType: listingMarketState.lastActivityType,
      lastActivityAt: listingMarketState.lastActivityAt,
      lastActivityTxHash,
      lastActivityProvider: listingMarketState.lastActivityProvider,
      sale: verifiedSale,
      metadataStatus: metadata,
    });
    persistListingMarketState(mint, listingMarketState);
    dbUpdated = true;
    const updatedRow = loadAssetByMint(mint) ?? previewRow;
    console.log(`[NFT LOOKUP] DB updated=${dbUpdated} provider=${listingMarketState.latestProvider}`);
    return {
      nft: rowToNftDto(updatedRow),
      cacheHit: false,
      heliusCalled: true,
      dbUpdated,
      providerUsed: [metadataProvider, activitySelection.provider].filter(Boolean).join("+"),
      reason: listingResult?.reason ?? activity.reason,
      verifiedSalesDetected,
      verifiedSalesStored,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "NFT provider unavailable";
    console.log(`[NFT LOOKUP] Helius failed: ${message}`);
    if (row) {
      console.log("[HELIUS ROTATION] cache fallback used=true");
      return {
        nft: rowToNftDto(row),
        cacheHit: true,
        heliusCalled: true,
        dbUpdated: false,
        providerUsed: asString(row.source_provider) ?? asString(row.latest_provider) ?? "helius",
        reason: "provider failure, returned cached result",
        verifiedSalesDetected: 0,
        verifiedSalesStored: 0,
        error: message,
      };
    }
    throw new Error("NFT not found or provider unavailable");
  }
}

export async function enrichNFTList(options: EnrichNFTListOptions = {}): Promise<EnrichNFTListResult> {
  const config = readNftScannerConfig({ dryRun: options.dryRun });
  const dryRun = config.nftListEnrichDryRun;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const focusMint = config.nftListEnrichFocusMint;
  const selectionOptions = focusMint ? { ...options, mint: focusMint, limit: 1 } : options;
  const rows = selectAssets(selectionOptions, config.nftListEnrichBatchSize);
  const errors: EnrichNFTListResult["errors"] = [];
  const changes: EnrichedNftChange[] = [];
  let metadataUpdated = 0;
  let imagesUpdated = 0;
  let ownersUpdated = 0;
  let assetTypesUpdated = 0;
  let categoriesUpdated = 0;
  let lastActivitiesDetected = 0;
  let lastActivitiesUpdated = 0;
  let verifiedSalesDetected = 0;
  let verifiedSalesStored = 0;

  const listingOnly = config.nftListEnrichListingOnly;
  console.log(`[NFT LIST ENRICH] Starting dryRun=${dryRun} batchSize=${config.nftListEnrichBatchSize} lane=${selectionOptions.lane ?? "all"} listingOnly=${listingOnly}`);
  if (focusMint) console.log(`[NFT LIST ENRICH] Focus mode enabled: ${focusMint}`);

  for (const row of rows) {
    const mint = asString(row.mint);
    if (!mint) continue;
    try {
      const metadataResult = await loadMetadataForMint({
        mint,
        row,
        market: asString(row.market) ?? asString(row.category) ?? "unknown",
        retries: config.nftListEnrichMaxRetries,
      });
      const { rawAsset, normalized } = metadataResult;
      const metadataProvider: MetadataProviderId = metadataResult.metadataProvider;
      const metadata = metadataStatus({ name: normalized.name, image: normalized.image, owner: normalized.owner });
      const fetchDetailedHistory = !listingOnly && shouldFetchDetailedHistory({
        row,
        lane: selectionOptions.lane,
        owner: normalized.owner,
        focusMint: focusMint === mint,
      });
      const activitySelection = await fetchActivityWithProviderStrategy({
        mint,
        owner: normalized.owner,
        collection: normalized.collection,
        retries: config.nftListEnrichMaxRetries,
        useDetailedHistory: fetchDetailedHistory,
        dbCacheAvailable: true,
        signaturesLimit: config.nftListEnrichSignaturesLimit,
      });
      const txs = activitySelection.txs;
      const latestTx = txs[0] ?? null;
      const activity = latestTx
        ? detectActivityFromTx(latestTx, mint, normalized.owner, normalized.collection, activitySelection.signatureCount)
        : unknownActivity(normalized.owner, listingOnly ? "listing-only mode: tx history skipped" : fetchDetailedHistory ? "no recent transaction found" : `skipped detailed transaction refresh for ${selectionOptions.lane ?? "all"} lane`);
      const verifiedSale = activitySelection.provider === "helius" ? activity.sale : null;
      const detectedCategory = detectRwaNftCategory({
        name: normalized.name,
        description: normalized.description,
        collection: normalized.collection,
        attributes: normalized.attributes,
      });
      const detectedAssetType = detectCollectibleAssetType({
        name: normalized.name,
        description: normalized.description,
        collection: normalized.collection,
        attributes: normalized.attributes,
        raw: rawAsset,
      });
      const detectedLastActivityAt = latestTx ? timestampFromTx(latestTx) : null;
      const detectedLastActivityTxHash = latestTx ? txSignature(latestTx) : null;
      const resolvedActivity = resolveStoredActivityState({
        row,
        detectedActivity: activity,
        detectedAt: detectedLastActivityAt,
        detectedTxHash: detectedLastActivityTxHash,
        owner: normalized.owner,
        activityProvider: activitySelection.provider,
      });
      const lastActivityAt = resolvedActivity.lastActivityAt;
      const lastActivityTxHash = resolvedActivity.lastActivityTxHash;
      if (latestTx && focusMint === mint) {
        console.log(`[NFT LIST ENRICH][DEBUG] mint=${mint} txHash=${activity.debug.txHash ?? "unknown"} currentOwner=${activity.debug.currentOwner ?? "unknown"} nftReceiver=${activity.debug.nftReceiver ?? "unknown"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] txType=${activity.debug.detectedType ?? "unknown"} source=${activity.debug.source ?? "unknown"} description=${activity.debug.description ?? "unknown"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] instructionPrograms=${activity.debug.instructionPrograms.length ? activity.debug.instructionPrograms.join(", ") : "none"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] allowlistAccounts=${activity.debug.matchedAllowlistAccounts.length ? activity.debug.matchedAllowlistAccounts.join(", ") : "none"} matchedPackSignal=${activity.debug.matchedPackSignal}`);
        console.log(`[NFT LIST ENRICH][DEBUG] nativeTransfers=${activity.debug.nativeTransfers.length ? activity.debug.nativeTransfers.join(" | ") : "none"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] tokenTransfers=${activity.debug.tokenTransfers.length ? activity.debug.tokenTransfers.join(" | ") : "none"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] nftTransfers=${activity.debug.nftTransfers.length ? activity.debug.nftTransfers.join(" | ") : "none"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] reason=${activity.reason}`);
        if (resolvedActivity.reason !== activity.reason) console.log(`[NFT LIST ENRICH][DEBUG] resolvedReason=${resolvedActivity.reason}`);
      }
      const change = buildChange({
        row,
        normalized,
        currentState: resolvedActivity.currentState,
        lastActivityType: resolvedActivity.lastActivityType,
        lastActivityAt,
        lastActivityTxHash,
        metadataStatus: metadata,
        detectedCategory,
        detectedAssetType,
      });

      if (change.nameUpdated || change.imageUpdated || change.ownerUpdated || change.assetTypeUpdated || change.categoryUpdated || change.metadataStatus !== row.metadata_status) metadataUpdated += 1;
      if (change.imageUpdated) imagesUpdated += 1;
      if (change.ownerUpdated) ownersUpdated += 1;
      if (change.assetTypeUpdated) assetTypesUpdated += 1;
      if (change.categoryUpdated) categoriesUpdated += 1;
      if (resolvedActivity.lastActivityType !== "unknown") lastActivitiesDetected += 1;
      if (change.lastActivityUpdated) lastActivitiesUpdated += 1;
      if (verifiedSale?.txSignature) verifiedSalesDetected += 1;
      changes.push(change);

      if (dryRun) {
        console.log(`[NFT LIST ENRICH][DRY RUN] ${mint} metadata=${metadata} state=${resolvedActivity.currentState} lastActivity=${resolvedActivity.lastActivityType} tx=${lastActivityTxHash ?? "none"}`);
        continue;
      }

      if (verifiedSale?.txSignature) {
        const category = verifiedSale.category ?? (isAllowedRwaNftCategory(detectedCategory) ? detectedCategory : asString(row.category));
        const result = await saveRwaNftMarketEvent({ ...verifiedSale, category });
        if (result.saved) verifiedSalesStored += 1;
      }
      updateAssetFromEnrichment({
        row,
        normalized,
        rawAsset,
        metadataProvider,
        fieldProviders: {
          metadata: metadataProvider,
          image: metadataProvider,
          owner: metadataProvider,
          collection: metadataProvider,
          assetType: metadataProvider,
          ...activitySelection.fieldProviders,
        },
        currentState: resolvedActivity.currentState,
        lastActivityType: resolvedActivity.lastActivityType,
        lastActivityAt,
        lastActivityTxHash,
        lastActivityProvider: resolvedActivity.lastActivityProvider,
        sale: verifiedSale,
        metadataStatus: metadata,
      });
    } catch (error) {
      errors.push({ mint, error: error instanceof Error ? error.message : "NFT List enrichment failed" });
      if (!dryRun) {
        getNftDb().prepare(`
          UPDATE nft_assets SET
            metadata_status = 'error',
            last_checked_at = ?,
            validation_status = 'failed',
            updated_at = ?
          WHERE mint = ?
        `).run(nowIso(), nowIso(), mint);
      }
    }
  }

  const durationMs = Date.now() - startedMs;
  const status = statusFromRun({
    startedAt,
    durationMs,
    checked: rows.length,
    found: changes.length,
    stored: dryRun ? 0 : changes.length,
    errors: errors.length,
    metadataUpdated,
    imagesUpdated,
    ownersUpdated,
    lastActivitiesUpdated,
  });
  saveProviderScanStatus(status, { dryRun });

  const finishedAt = nowIso();
  console.log(`[NFT LIST ENRICH] Completed checked=${rows.length} metadata=${metadataUpdated} images=${imagesUpdated} owners=${ownersUpdated} activities=${lastActivitiesDetected} errors=${errors.length}`);

  return {
    dryRun,
    startedAt,
    finishedAt,
    durationMs,
    nftsChecked: rows.length,
    metadataUpdated,
    imagesUpdated,
    ownersUpdated,
    assetTypesUpdated,
    categoriesUpdated,
    lastActivitiesDetected,
    lastActivitiesUpdated,
    verifiedSalesDetected,
    verifiedSalesStored,
    providersUsed: [
      ...(hasShyftApiKey() ? ["shyft"] : []),
      ...(hasHeliusApiKey() ? ["helius"] : []),
      "solscan",
    ],
    errors,
    changes: changes.slice(0, 50),
    providerStatuses: [status],
  };
}
