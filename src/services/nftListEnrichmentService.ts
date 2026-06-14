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

type RuntimeEnv = Record<string, string | undefined>;
type SqlRow = Record<string, unknown>;

export type EnrichNFTListOptions = {
  mint?: string | null;
  limit?: number | null;
  dryRun?: boolean | null;
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
  let sql = "SELECT * FROM nft_assets";
  if (options.mint) {
    sql += " WHERE mint = ?";
    params.push(options.mint);
  }
  sql += " ORDER BY last_checked_at IS NULL DESC, last_checked_at ASC, updated_at DESC";
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

function rowNeedsRefresh(row: SqlRow | undefined, ttlSeconds: number) {
  if (!row) return true;
  const ttlMs = ttlSeconds * 1000;
  const checkedAt = parseDate(row.last_checked_at);
  const ageMs = checkedAt ? Date.now() - checkedAt : Number.POSITIVE_INFINITY;
  const stale = !checkedAt || ageMs > ttlMs;
  const incomplete = rowMetadataStatus(row) !== "complete" || !asString(row.owner) || !asString(row.image);
  return stale || incomplete;
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
  const apiKey = env().HELIUS_API_KEY;
  if (!apiKey) throw new Error("Missing HELIUS_API_KEY");
  const response = await fetch(`${HELIUS_RPC_URL}?api-key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  const payload = await response.json() as { result?: unknown; error?: { message?: string } };
  if (!response.ok || payload.error) throw new Error(payload.error?.message ?? `Helius ${method} failed: ${response.status}`);
  return payload.result;
}

async function recentSignaturesForMint(mint: string, limit = 8) {
  const result = await heliusRpc("getSignaturesForAddress", [mint, { limit }]);
  return Array.isArray(result) ? result.map(asRecord) : [];
}

async function enhancedTransactions(signatures: string[]) {
  const apiKey = env().HELIUS_API_KEY;
  if (!apiKey || signatures.length === 0) return [];
  const response = await fetch(`${HELIUS_ENHANCED_TX_URL}?api-key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactions: signatures }),
  });
  if (!response.ok) throw new Error(`Helius Enhanced Transactions failed: ${response.status}`);
  const payload = await response.json() as unknown;
  return Array.isArray(payload) ? payload.map(asRecord) : [];
}

function timestampFromTx(tx: Record<string, unknown>) {
  const raw = tx.timestamp ?? tx.blockTime ?? tx.createdAt ?? tx.time;
  if (typeof raw === "number") return new Date(raw < 10_000_000_000 ? raw * 1000 : raw).toISOString();
  return asString(raw);
}

function txSignature(tx: Record<string, unknown>) {
  return asString(tx.signature) ?? asString(tx.transactionSignature) ?? asString(tx.txHash);
}

function textFromTx(tx: Record<string, unknown>) {
  return [
    tx.type,
    tx.source,
    tx.description,
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

function detectActivityFromTx(tx: Record<string, unknown>, mint: string, owner: string | null, collectionAddress: string | null): {
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

  if (packEvidence.matched) {
    return {
      type: "pack_opened",
      state: owner ? "owned" : "unknown",
      sale: null,
      reason: packEvidence.reason,
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
  if (text.includes("delist") || text.includes("cancel listing")) {
    return {
      type: "delisted",
      state: "unlisted",
      sale: null,
      reason: "transaction text included delist/cancel listing wording",
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
  if (text.includes("transfer")) {
    return {
      type: "transferred",
      state: owner ? "owned" : "transferred_out",
      sale: null,
      reason: `transaction text only showed transfer wording and pack evidence stayed insufficient: ${packEvidence.reason}`,
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
  currentState: NFTMarketStatus;
  lastActivityType: NFTLastActivityType;
  lastActivityAt: string | null;
  lastActivityTxHash: string | null;
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
      source_provider = COALESCE(source_provider, 'helius'),
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
    input.currentState,
    input.currentState,
    input.lastActivityType,
    input.lastActivityAt,
    input.lastActivityTxHash,
    "helius",
    "helius",
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
      provider: "helius",
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
  return {
    provider: "helius",
    scanType: "market_state",
    status: env().HELIUS_API_KEY ? input.errors ? "error" : "live" : "needs_api_key",
    lastRunAt: input.startedAt,
    lastSuccessAt: input.errors || !env().HELIUS_API_KEY ? null : nowIso(),
    lastError: !env().HELIUS_API_KEY ? "Missing HELIUS_API_KEY" : input.errors ? `${input.errors} NFT(s) failed` : null,
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

function mergeEnrichmentPreview(row: SqlRow | undefined, normalized: ReturnType<typeof normalizeHeliusAsset>, activity: ReturnType<typeof detectActivityFromTx>, metadata: NFTMetadataStatus, lastActivityAt: string | null, lastActivityTxHash: string | null) {
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
    current_state: activity.state,
    current_status: activity.state,
    last_activity_type: activity.type,
    last_activity_at: lastActivityAt,
    last_activity_tx_hash: lastActivityTxHash ?? asString(base.last_activity_tx_hash),
    last_activity_provider: "helius",
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
      lastActivityType: activity.type,
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
};

function deriveListingMarketState(input: {
  row: SqlRow;
  activity: ReturnType<typeof detectActivityFromTx>;
  listingResult: ActiveMintListingLookupResult | null;
  lastActivityAt: string | null;
}) : DerivedListingMarketState {
  const listing = input.listingResult?.listing ?? null;
  const hasListing = Boolean(input.listingResult?.found && listing);
  const listingAt = hasListing ? (listing?.listedAt ?? null) : null;
  const listingIsNewer = hasListing && Boolean(listingAt) && ((parseDate(listingAt) ?? 0) >= (parseDate(input.lastActivityAt) ?? 0));
  const currentState = hasListing
    ? "listed"
    : input.activity.state === "listed"
      ? "owned"
      : input.activity.state;
  const lastActivityType = hasListing && listingIsNewer ? "listed" : input.activity.type;
  const lastActivityAt = hasListing && listingIsNewer ? (listingAt ?? input.lastActivityAt) : input.lastActivityAt;
  const lastActivityProvider = hasListing && listingIsNewer ? listing!.providerId : "helius";
  const latestProvider = input.activity.sale?.txSignature ? "helius" : hasListing ? listing!.providerId : "helius";
  const latestMarketplace = input.activity.sale?.marketplace ?? (hasListing ? listing!.marketplace : asString(input.row.latest_marketplace));
  const latestMarketPriceSol =
    input.activity.sale?.priceSol
    ?? (typeof input.row.latest_market_price_sol === "number" ? input.row.latest_market_price_sol : null)
    ?? (hasListing ? listing!.priceSol : null);
  const latestMarketPriceUsd =
    input.activity.sale?.priceUsd
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
      latestMarketPricePriority: input.activity.sale?.txSignature ? "verified_sale" : hasListing ? "active_listing" : "unknown",
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
    marketState.rawMarketStateJson,
    timestamp,
    timestamp,
    mint,
  );
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
    const rawAsset = await withRetries(config.nftListEnrichMaxRetries, () => getAssetByMint(mint));
    const normalized = normalizeHeliusAsset(rawAsset, asString(row?.market) ?? asString(row?.category) ?? "unknown");
    const metadata = metadataStatus({ name: normalized.name, image: normalized.image, owner: normalized.owner });
    const signatures = await withRetries(config.nftListEnrichMaxRetries, () => recentSignaturesForMint(mint, 8));
    const signatureValues = signatures.map((signature) => asString(signature.signature)).filter((signature): signature is string => Boolean(signature));
    const txs = await withRetries(config.nftListEnrichMaxRetries, () => enhancedTransactions(signatureValues.slice(0, 8)));
    const latestTx = txs[0] ?? null;
    const activity = latestTx
      ? detectActivityFromTx(latestTx, mint, normalized.owner, normalized.collection)
      : {
          type: "unknown" as const,
          state: normalized.owner ? "owned" as const : "unknown" as const,
          sale: null,
          reason: "no recent transaction found",
          debug: {
            txHash: null,
            detectedType: null,
            currentOwner: normalized.owner,
            nftReceiver: null,
            source: null,
            description: null,
            instructionPrograms: [],
            matchedAllowlistAccounts: [],
            matchedPackSignal: false,
            nativeTransfers: [],
            tokenTransfers: [],
            nftTransfers: [],
          },
        };
    const lastActivityAt = latestTx ? timestampFromTx(latestTx) : null;
    const lastActivityTxHash = latestTx ? txSignature(latestTx) : null;
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
    }

    if (activity.sale?.txSignature) {
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
    const previewBaseRow = mergeEnrichmentPreview(row, normalized, activity, metadata, lastActivityAt, lastActivityTxHash);
    const listingMarketState = deriveListingMarketState({
      row: previewBaseRow,
      activity,
      listingResult,
      lastActivityAt,
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
        providerUsed: listingMarketState.latestProvider,
        reason: listingResult?.reason ?? activity.reason,
        verifiedSalesDetected,
        verifiedSalesStored: 0,
        error: null,
      };
    }

    if (!row) {
      insertAssetPlaceholderIfMissing(mint, market, normalized, metadata);
    }

    if (activity.sale?.txSignature) {
      const category = activity.sale.category ?? (isAllowedRwaNftCategory(detectedCategory) ? detectedCategory : asString(row?.category));
      const result = await saveRwaNftMarketEvent({ ...activity.sale, category });
      if (result.saved) verifiedSalesStored += 1;
    }

    updateAssetFromEnrichment({
      row: row ?? mergePreviewRow(null, { mint, market, category: market, asset_type: "unknown", public_group: "other" }),
      normalized,
      rawAsset,
      currentState: activity.state,
      lastActivityType: activity.type,
      lastActivityAt,
      lastActivityTxHash,
      sale: activity.sale,
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
      providerUsed: listingMarketState.latestProvider,
      reason: listingResult?.reason ?? activity.reason,
      verifiedSalesDetected,
      verifiedSalesStored,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "NFT provider unavailable";
    console.log(`[NFT LOOKUP] Helius failed: ${message}`);
    if (row) {
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

  console.log(`[NFT LIST ENRICH] Starting dryRun=${dryRun} batchSize=${config.nftListEnrichBatchSize}`);
  if (focusMint) console.log(`[NFT LIST ENRICH] Focus mode enabled: ${focusMint}`);

  for (const row of rows) {
    const mint = asString(row.mint);
    if (!mint) continue;
    try {
      const rawAsset = await withRetries(config.nftListEnrichMaxRetries, () => getAssetByMint(mint));
      const normalized = normalizeHeliusAsset(rawAsset, asString(row.market) ?? asString(row.category) ?? "unknown");
      const metadata = metadataStatus({ name: normalized.name, image: normalized.image, owner: normalized.owner });
      const signatures = await withRetries(config.nftListEnrichMaxRetries, () => recentSignaturesForMint(mint, 8));
      const signatureValues = signatures.map((signature) => asString(signature.signature)).filter((signature): signature is string => Boolean(signature));
      const txs = await withRetries(config.nftListEnrichMaxRetries, () => enhancedTransactions(signatureValues.slice(0, 8)));
      const latestTx = txs[0] ?? null;
      const activity = latestTx
        ? detectActivityFromTx(latestTx, mint, normalized.owner, normalized.collection)
        : {
            type: "unknown" as const,
            state: normalized.owner ? "owned" as const : "unknown" as const,
            sale: null,
            reason: "no recent transaction found",
            debug: {
              txHash: null,
              detectedType: null,
              currentOwner: normalized.owner,
              nftReceiver: null,
              source: null,
              description: null,
              instructionPrograms: [],
              matchedAllowlistAccounts: [],
              matchedPackSignal: false,
              nativeTransfers: [],
              tokenTransfers: [],
              nftTransfers: [],
            },
          };
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
      const lastActivityAt = latestTx ? timestampFromTx(latestTx) : null;
      const lastActivityTxHash = latestTx ? txSignature(latestTx) : null;
      if (latestTx && focusMint === mint) {
        console.log(`[NFT LIST ENRICH][DEBUG] mint=${mint} txHash=${activity.debug.txHash ?? "unknown"} currentOwner=${activity.debug.currentOwner ?? "unknown"} nftReceiver=${activity.debug.nftReceiver ?? "unknown"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] txType=${activity.debug.detectedType ?? "unknown"} source=${activity.debug.source ?? "unknown"} description=${activity.debug.description ?? "unknown"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] instructionPrograms=${activity.debug.instructionPrograms.length ? activity.debug.instructionPrograms.join(", ") : "none"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] allowlistAccounts=${activity.debug.matchedAllowlistAccounts.length ? activity.debug.matchedAllowlistAccounts.join(", ") : "none"} matchedPackSignal=${activity.debug.matchedPackSignal}`);
        console.log(`[NFT LIST ENRICH][DEBUG] nativeTransfers=${activity.debug.nativeTransfers.length ? activity.debug.nativeTransfers.join(" | ") : "none"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] tokenTransfers=${activity.debug.tokenTransfers.length ? activity.debug.tokenTransfers.join(" | ") : "none"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] nftTransfers=${activity.debug.nftTransfers.length ? activity.debug.nftTransfers.join(" | ") : "none"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] reason=${activity.reason}`);
      }
      const change = buildChange({
        row,
        normalized,
        currentState: activity.state,
        lastActivityType: activity.type,
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
      if (activity.type !== "unknown") lastActivitiesDetected += 1;
      if (change.lastActivityUpdated) lastActivitiesUpdated += 1;
      if (activity.sale?.txSignature) verifiedSalesDetected += 1;
      changes.push(change);

      if (dryRun) {
        console.log(`[NFT LIST ENRICH][DRY RUN] ${mint} metadata=${metadata} state=${activity.state} lastActivity=${activity.type} tx=${lastActivityTxHash ?? "none"}`);
        continue;
      }

      if (activity.sale?.txSignature) {
        const category = activity.sale.category ?? (isAllowedRwaNftCategory(detectedCategory) ? detectedCategory : asString(row.category));
        const result = await saveRwaNftMarketEvent({ ...activity.sale, category });
        if (result.saved) verifiedSalesStored += 1;
      }
      updateAssetFromEnrichment({
        row,
        normalized,
        rawAsset,
        currentState: activity.state,
        lastActivityType: activity.type,
        lastActivityAt,
        lastActivityTxHash,
        sale: activity.sale,
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
    providersUsed: env().HELIUS_API_KEY ? ["helius"] : [],
    errors,
    changes: changes.slice(0, 50),
    providerStatuses: [status],
  };
}
