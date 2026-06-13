import type { NFTLastActivityType, NFTMarketStatus, NFTMetadataStatus, ProviderScanStatus, RwaNftMarketEvent } from "@/types/rwaNftMarket";
import { parseHeliusEnhancedTransaction } from "./heliusEnhancedTransactionParser";
import { getAssetByMint, normalizeHeliusAsset } from "./heliusNftService";
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
const KNOWN_PACK_OPEN_PROGRAM_IDS = new Set([
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
  "phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC",
]);

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

function detectPackOpeningEvidence(tx: Record<string, unknown>, mint: string, owner: string | null) {
  const saleEvents = parseHeliusEnhancedTransaction(tx, { fallbackMint: mint }).filter((event) => event.eventType === "SALE");
  if (saleEvents.length > 0) return null;

  const text = textFromTx(tx);
  const programs = instructionPrograms(tx);
  const accounts = accountDataAccounts(tx);
  const touchedMint = accounts.includes(mint);
  const ownerTouched = owner ? accounts.includes(owner) : false;
  const hasPackWording = /pack|opened?|reveal|claim/.test(text);
  const hasKnownPackProgram = programs.some((program) => KNOWN_PACK_OPEN_PROGRAM_IDS.has(program));

  if (!touchedMint || !ownerTouched) return null;
  if (!hasPackWording && !hasKnownPackProgram) return null;

  const matchedProgram = programs.find((program) => KNOWN_PACK_OPEN_PROGRAM_IDS.has(program)) ?? null;
  const reason = hasPackWording
    ? "pack/open wording matched and the mint + owner were both touched"
    : `known pack-opening program matched: ${matchedProgram}`;

  return {
    reason,
    matchedProgram,
    programs,
    accounts,
    text,
  };
}

function detectActivityFromTx(tx: Record<string, unknown>, mint: string, owner: string | null): {
  type: NFTLastActivityType;
  state: NFTMarketStatus;
  sale: RwaNftMarketEvent | null;
  reason: string;
  debug: {
    detectedType: string | null;
    source: string | null;
    description: string | null;
    instructionPrograms: string[];
    nativeTransfers: string[];
    tokenTransfers: string[];
    nftTransfers: string[];
  };
} {
  const sales = parseHeliusEnhancedTransaction(tx, { fallbackMint: mint }).filter((event) => event.eventType === "SALE");
  const sale = sales[0] ?? null;
  const packEvidence = detectPackOpeningEvidence(tx, mint, owner);
  const instructionProgramList = instructionPrograms(tx);
  const nativeTransferSummary = summarizeNativeTransfers(tx);
  const tokenTransferSummary = summarizeTokenTransfers(tx);
  const nftTransferSummary = summarizeNftTransfers(tx);
  if (sale?.txSignature) {
    const ownerIsBuyer = Boolean(owner && (sale.buyer === owner || sale.owner === owner));
    return {
      type: ownerIsBuyer ? "bought" : "sold",
      state: ownerIsBuyer ? "owned" : "sold",
      sale,
      reason: "verified sale detected by Helius enhanced transaction parser",
      debug: {
        detectedType: String(tx.type ?? null),
        source: asString(tx.source),
        description: asString(tx.description),
        instructionPrograms: instructionProgramList,
        nativeTransfers: nativeTransferSummary,
        tokenTransfers: tokenTransferSummary,
        nftTransfers: nftTransferSummary,
      },
    };
  }

  if (packEvidence) {
    return {
      type: "pack_opened",
      state: owner ? "owned" : "unknown",
      sale: null,
      reason: packEvidence.reason,
      debug: {
        detectedType: String(tx.type ?? null),
        source: asString(tx.source),
        description: asString(tx.description),
        instructionPrograms: instructionProgramList,
        nativeTransfers: nativeTransferSummary,
        tokenTransfers: tokenTransferSummary,
        nftTransfers: nftTransferSummary,
      },
    };
  }

  const text = textFromTx(tx);
  if (text.includes("mint")) {
    return {
      type: "minted",
      state: owner ? "owned" : "unknown",
      sale: null,
      reason: "transaction text included mint wording",
      debug: {
        detectedType: String(tx.type ?? null),
        source: asString(tx.source),
        description: asString(tx.description),
        instructionPrograms: instructionProgramList,
        nativeTransfers: nativeTransferSummary,
        tokenTransfers: tokenTransferSummary,
        nftTransfers: nftTransferSummary,
      },
    };
  }
  if (text.includes("delist") || text.includes("cancel listing")) {
    return {
      type: "delisted",
      state: "unlisted",
      sale: null,
      reason: "transaction text included delist/cancel listing wording",
      debug: {
        detectedType: String(tx.type ?? null),
        source: asString(tx.source),
        description: asString(tx.description),
        instructionPrograms: instructionProgramList,
        nativeTransfers: nativeTransferSummary,
        tokenTransfers: tokenTransferSummary,
        nftTransfers: nftTransferSummary,
      },
    };
  }
  if (text.includes("list")) {
    return {
      type: "listed",
      state: "listed",
      sale: null,
      reason: "transaction text included list wording",
      debug: {
        detectedType: String(tx.type ?? null),
        source: asString(tx.source),
        description: asString(tx.description),
        instructionPrograms: instructionProgramList,
        nativeTransfers: nativeTransferSummary,
        tokenTransfers: tokenTransferSummary,
        nftTransfers: nftTransferSummary,
      },
    };
  }
  if (text.includes("transfer")) {
    return {
      type: "transferred",
      state: owner ? "owned" : "transferred_out",
      sale: null,
      reason: "transaction text only showed transfer wording and no stronger pack evidence was present",
      debug: {
        detectedType: String(tx.type ?? null),
        source: asString(tx.source),
        description: asString(tx.description),
        instructionPrograms: instructionProgramList,
        nativeTransfers: nativeTransferSummary,
        tokenTransfers: tokenTransferSummary,
        nftTransfers: nftTransferSummary,
      },
    };
  }
  return {
    type: "unknown",
    state: owner ? "owned" : "unknown",
    sale: null,
    reason: "no verified sale, pack-opening, mint, listing, or transfer pattern was strong enough",
    debug: {
      detectedType: String(tx.type ?? null),
      source: asString(tx.source),
      description: asString(tx.description),
      instructionPrograms: instructionProgramList,
      nativeTransfers: nativeTransferSummary,
      tokenTransfers: tokenTransferSummary,
      nftTransfers: nftTransferSummary,
    },
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
        ? detectActivityFromTx(latestTx, mint, normalized.owner)
        : { type: "unknown" as const, state: normalized.owner ? "owned" as const : "unknown" as const, sale: null };
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

      if (focusMint && latestTx) {
        console.log(`[NFT LIST ENRICH][DEBUG] txType=${activity.debug.detectedType ?? "unknown"} source=${activity.debug.source ?? "unknown"} description=${activity.debug.description ?? "unknown"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] instructionPrograms=${activity.debug.instructionPrograms.length ? activity.debug.instructionPrograms.join(", ") : "none"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] nativeTransfers=${activity.debug.nativeTransfers.length ? activity.debug.nativeTransfers.join(" | ") : "none"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] tokenTransfers=${activity.debug.tokenTransfers.length ? activity.debug.tokenTransfers.join(" | ") : "none"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] nftTransfers=${activity.debug.nftTransfers.length ? activity.debug.nftTransfers.join(" | ") : "none"}`);
        console.log(`[NFT LIST ENRICH][DEBUG] reason=${activity.reason}`);
      }

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
