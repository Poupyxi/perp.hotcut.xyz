import { mkdirSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ALLOWED_RWA_NFT_CATEGORIES, detectRwaNftCategory, isAllowedRwaNftCategory } from "./nftCategoryService";
import { detectCollectibleAssetType, publicGroupForAssetType, type RwaCollectibleAssetType, type RwaCollectiblePublicGroup } from "./nftAssetTypeService";
import { getNftDb, nftDatabasePath, shouldStoreRawHeliusJson, sqliteBool, stringifyJson } from "./nftSqliteDb";
import { fetchWithHeliusKey, hasHeliusApiKey } from "./heliusApiKeyRotation";
import { getTrackedMarketCategory, trackedMarketLabel } from "./trackedMarketCategories";
import { getAllowedNftCollections, type TargetNftCollectionConfig } from "./trackedNftsConfig";

const HELIUS_RPC_URL = "https://mainnet.helius-rpc.com/";
const DEFAULT_PAGE_LIMIT = 1000;
const REPORT_DIR = "ingestion-reports";

type RuntimeEnv = Record<string, string | undefined>;

export type IngestAllowedCollectionsOptions = {
  dryRun?: boolean;
  countOnly?: boolean;
  debugPagination?: boolean;
  limitPages?: number | null;
  limitAssets?: number | null;
  collection?: string | null;
  delayMs?: number;
  resume?: boolean;
  includeStaging?: boolean;
  storeRaw?: boolean;
  compareUniverse?: boolean;
};

export type HeliusPage = {
  items: unknown[];
  total: number | null;
  page: number | null;
  limit: number | null;
};

type PaginationDebugEntry = {
  collection: string;
  groupKey: "collection";
  groupValue: string;
  requestedPage: number;
  requestedLimit: number;
  resultPage: number | null;
  resultLimit: number | null;
  resultTotal: number | null;
  itemsLength: number;
  cumulativeCount: number;
  totalGreaterThanItemsLength: boolean;
  stopCondition: string | null;
};

export type AssetCandidate = {
  mint: string;
  name: string | null;
  description: string | null;
  image: string | null;
  owner: string | null;
  collection: string | null;
  category: string;
  categorySource: "attribute_filter" | "metadata" | "fallback_collection" | "unknown";
  assetType: RwaCollectibleAssetType;
  publicGroup: RwaCollectiblePublicGroup;
  market: string;
  attributes: unknown[];
  tokenStandard: string | null;
  interface: string | null;
  sourceCollection: string;
  sourceCollectionLabel: string;
  isStaging: boolean;
  previousFilterMatched: boolean;
  previousFilterMatchedCard: boolean;
  previousFilterMatchedOther: boolean;
  raw: unknown;
};

type CollectionReport = {
  key: string;
  label: string;
  market: string;
  collectionAddress: string;
  stagingCollection: boolean;
  skippedCollection: boolean;
  pagesScanned: number;
  heliusReportedTotal: number | null;
  requestedGroupKey: "collection";
  requestedLimit: number;
  expectedPagesFromTotal: number | null;
  totalCountedByScript: number;
  stopReason: string | null;
  paginationWarnings: string[];
  paginationDebug: PaginationDebugEntry[];
  assetsSeen: number;
  previousFilterMatchedAssets: number;
  previousFilterMatchedCards: number;
  previousFilterMatchedOther: number;
  previousFilterMatchedVisibleAssets: number;
  newVisibleAssetsMissedByPreviousFilter: number;
  newVisibleCardAssetsMissedByPreviousFilter: number;
  newVisibleOtherAssetsMissedByPreviousFilter: number;
  allowedCategoryAssets: number;
  unknownCategoryAssets: number;
  stagingAssets: number;
  visibleAfterPublicFilters: number;
  hiddenOtherAssets: number;
  assetTypeCounts: Record<string, number>;
  publicGroupCounts: Record<string, number>;
  duplicatesWithinRunSkipped: number;
  duplicatesAlreadyExisting: number;
  wouldInsert: number;
  wouldUpdate: number;
  inserted: number;
  updated: number;
  categoryCounts: Record<string, number>;
  cardCategoryCounts: Record<string, number>;
  otherCategoryCounts: Record<string, number>;
  excluded: Record<string, number>;
  errors: string[];
};

export type NftUniverseIngestionReport = {
  dryRun: boolean;
  countOnly: boolean;
  compareUniverse: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  duration: string;
  options: Required<Omit<IngestAllowedCollectionsOptions, "collection" | "limitAssets" | "limitPages">> & {
    collection: string | null;
    limitAssets: number | null;
    limitPages: number | null;
  };
  allowlistedCollections: Array<TargetNftCollectionConfig & { key: string; stagingCollection: boolean }>;
  collections: CollectionReport[];
  paginationDebug: Record<string, PaginationDebugEntry[]>;
  totals: {
    collectionsProcessed: number;
    pagesProcessed: number;
    heliusAssetsSeen: number;
    previousFilterMatchedAssets: number;
    previousFilterMatchedCards: number;
    previousFilterMatchedOther: number;
    previousFilterMatchedVisibleAssets: number;
    newVisibleAssetsMissedByPreviousFilter: number;
    newVisibleCardAssetsMissedByPreviousFilter: number;
    newVisibleOtherAssetsMissedByPreviousFilter: number;
    allowedCategoryAssets: number;
    unknownCategoryAssets: number;
    stagingAssets: number;
    visibleAfterPublicFilters: number;
    hiddenOtherAssets: number;
    duplicatesWithinRunSkipped: number;
    duplicatesAlreadyExisting: number;
    wouldInsert: number;
    wouldUpdate: number;
    inserted: number;
    updated: number;
    categoryCounts: Record<string, number>;
    cardCategoryCounts: Record<string, number>;
    otherCategoryCounts: Record<string, number>;
    assetTypeCounts: Record<string, number>;
    publicGroupCounts: Record<string, number>;
    sourceCollectionCounts: Record<string, number>;
    missingImageCount: number;
    missingNameCount: number;
    missingOwnerCount: number;
    excluded: Record<string, number>;
    errors: number;
  };
  comparison: {
    previousFilterMatchedAssets: number;
    previousFilterMatchedCards: number;
    previousFilterMatchedOther: number;
    previousFilterMatchedVisibleAssets: number;
    visibleAfterPublicFilters: number;
    newVisibleAssetsMissedByPreviousFilter: number;
    newVisibleCardAssetsMissedByPreviousFilter: number;
    newVisibleOtherAssetsMissedByPreviousFilter: number;
    difference: number;
    matchesPreviousFilterInScannedPages: boolean;
    note: string;
  };
  reportPath: string;
};

function env(): RuntimeEnv {
  return (globalThis as unknown as { process?: { env?: RuntimeEnv } }).process?.env ?? {};
}

function nowIso() {
  return new Date().toISOString();
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "unknown";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function attributesFromMetadata(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isStagingText(...values: unknown[]) {
  return values.some((value) => String(value ?? "").toLowerCase().includes("staging"));
}

function addCount(target: Record<string, number>, key: string, amount = 1) {
  target[key] = (target[key] ?? 0) + amount;
}

function reportDirectory() {
  return join(dirname(nftDatabasePath()), REPORT_DIR);
}

function reportPath(prefix: string) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return join(reportDirectory(), `${prefix}-${stamp}.json`);
}

function latestReportPath(prefix: string) {
  const directory = reportDirectory();
  if (!existsSync(directory)) return null;
  const files = readdirSync(directory)
    .filter((file) => file.startsWith(prefix) && file.endsWith(".json"))
    .map((file) => join(directory, file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

function normalizeCollectionKey(collection: TargetNftCollectionConfig) {
  return `${slug(collection.label)}-${collection.collectionAddress.slice(0, 8)}`;
}

export function normalizeNftUniverseAsset(raw: unknown, collection: TargetNftCollectionConfig): AssetCandidate | null {
  const record = asRecord(raw);
  const content = asRecord(record.content);
  const metadata = asRecord(content.metadata);
  const links = asRecord(content.links);
  const ownership = asRecord(record.ownership);
  const tokenInfo = asRecord(record.token_info);
  const grouping = Array.isArray(record.grouping) ? record.grouping.map(asRecord) : [];
  const collectionGroup = grouping.find((group) => group.group_key === "collection");
  const mint = asString(record.id);
  if (!mint) return null;

  const attributes = attributesFromMetadata(metadata.attributes);
  const attributeCategory = getTrackedMarketCategory(attributes);
  const metadataCategory = detectRwaNftCategory({
    name: asString(metadata.name),
    description: asString(metadata.description),
    collection: asString(collectionGroup?.group_value) ?? collection.collectionAddress,
    attributes,
  });
  const category = attributeCategory?.market ?? (metadataCategory !== "unknown" ? metadataCategory : "unknown");
  const categorySource = attributeCategory
    ? "attribute_filter"
    : metadataCategory !== "unknown"
      ? "metadata"
      : "unknown";
  const sourceCollection = asString(collectionGroup?.group_value) ?? collection.collectionAddress;
  const assetType = detectCollectibleAssetType({
    name: asString(metadata.name),
    description: asString(metadata.description),
    collection: sourceCollection,
    attributes,
    raw,
  });
  const publicGroup = publicGroupForAssetType(assetType);
  const previousFilterMatched = Boolean(attributeCategory);

  return {
    mint,
    name: asString(metadata.name),
    description: asString(metadata.description),
    image: asString(links.image),
    owner: asString(ownership.owner),
    collection: sourceCollection,
    category: isAllowedRwaNftCategory(category) ? category : "unknown",
    categorySource,
    assetType,
    publicGroup,
    market: isAllowedRwaNftCategory(category) ? category : collection.market,
    attributes,
    tokenStandard: asString(tokenInfo.token_program) ?? asString(record.interface),
    interface: asString(record.interface),
    sourceCollection: collection.collectionAddress,
    sourceCollectionLabel: collection.label,
    isStaging: isStagingText(metadata.name, sourceCollection, collection.label),
    previousFilterMatched,
    previousFilterMatchedCard: previousFilterMatched && assetType === "card",
    previousFilterMatchedOther: previousFilterMatched && assetType !== "card",
    raw,
  };
}

export async function heliusAssetsPage(collectionAddress: string, page: number, limit: number): Promise<HeliusPage> {
  if (!hasHeliusApiKey()) throw new Error("Missing HELIUS_API_KEY");

  const response = await fetchWithHeliusKey({
    label: "collection-ingestion:getAssetsByGroup",
    endpoint: HELIUS_RPC_URL,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "ingest-allowed-collections",
        method: "getAssetsByGroup",
        params: {
          groupKey: "collection",
          groupValue: collectionAddress,
          page,
          limit,
        },
      }),
    },
  });

  if (response.status === 429) throw new Error("Helius rate limit hit");
  if (!response.ok) throw new Error(`Helius request failed: ${response.status} ${response.statusText}`);
  const payload = await response.json() as { result?: { items?: unknown[]; total?: number; page?: number; limit?: number }; error?: { message?: string } };
  if (payload.error) throw new Error(payload.error.message ?? "Helius returned an error");
  return {
    items: Array.isArray(payload.result?.items) ? payload.result.items : [],
    total: typeof payload.result?.total === "number" ? payload.result.total : null,
    page: typeof payload.result?.page === "number" ? payload.result.page : null,
    limit: typeof payload.result?.limit === "number" ? payload.result.limit : null,
  };
}

function loadExistingAssets() {
  const rows = getNftDb().prepare("SELECT mint, updated_at FROM nft_assets").all() as Array<{ mint: string; updated_at: string | null }>;
  return new Map(rows.map((row) => [row.mint, row]));
}

function upsertNftAsset(candidate: AssetCandidate, options: { storeRaw: boolean }) {
  const timestamp = nowIso();
  getNftDb().prepare(`
    INSERT INTO nft_assets (
      id, mint, market, name, description, image, owner, collection, category, attributes_json,
      asset_type, public_group, token_standard, interface, source_collection, is_staging, raw_helius_json, is_listed,
      listed_price_sol, listed_price_usd, listing_marketplace, listing_updated_at,
      last_sale_price_sol, last_sale_price_usd, last_sale_at, last_sale_marketplace, last_sale_tx_signature,
      floor_price_sol, market_updated_at, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(mint) DO UPDATE SET
      market = excluded.market,
      name = excluded.name,
      description = excluded.description,
      image = excluded.image,
      owner = excluded.owner,
      collection = excluded.collection,
      category = excluded.category,
      asset_type = excluded.asset_type,
      public_group = excluded.public_group,
      attributes_json = excluded.attributes_json,
      token_standard = excluded.token_standard,
      interface = excluded.interface,
      source_collection = excluded.source_collection,
      is_staging = excluded.is_staging,
      raw_helius_json = excluded.raw_helius_json,
      updated_at = excluded.updated_at
  `).run(
    slug(candidate.mint),
    candidate.mint,
    candidate.market,
    candidate.name,
    candidate.description,
    candidate.image,
    candidate.owner,
    candidate.collection,
    candidate.category,
    stringifyJson(candidate.attributes),
    candidate.assetType,
    candidate.publicGroup,
    candidate.tokenStandard,
    candidate.interface,
    candidate.sourceCollection,
    sqliteBool(candidate.isStaging),
    options.storeRaw || shouldStoreRawHeliusJson() ? stringifyJson(candidate.raw) : null,
    timestamp,
    timestamp,
  );
}

function updateIngestionState(input: {
  running: boolean;
  currentCollection?: string | null;
  currentPage?: number | null;
  inserted?: number;
  updated?: number;
  duplicatesSkipped?: number;
  lastError?: string | null;
  ingestionReportPath?: string | null;
  universeReportPath?: string | null;
}) {
  getNftDb().prepare(`
    UPDATE queue_state SET
      ingestion_running = ?,
      ingestion_current_collection = ?,
      ingestion_current_page = ?,
      ingestion_inserted = ?,
      ingestion_updated = ?,
      ingestion_duplicates_skipped = ?,
      ingestion_last_error = ?,
      latest_ingestion_report_path = COALESCE(?, latest_ingestion_report_path),
      latest_universe_comparison_report_path = COALESCE(?, latest_universe_comparison_report_path),
      updated_at = ?
    WHERE id = 'default'
  `).run(
    sqliteBool(input.running),
    input.currentCollection ?? null,
    input.currentPage ?? null,
    input.inserted ?? 0,
    input.updated ?? 0,
    input.duplicatesSkipped ?? 0,
    input.lastError ?? null,
    input.ingestionReportPath ?? null,
    input.universeReportPath ?? null,
    nowIso(),
  );
}

function initCollectionReport(collection: TargetNftCollectionConfig): CollectionReport {
  return {
    key: normalizeCollectionKey(collection),
    label: collection.label,
    market: collection.market,
    collectionAddress: collection.collectionAddress,
    stagingCollection: isStagingText(collection.label, collection.collectionAddress),
    skippedCollection: false,
    pagesScanned: 0,
    heliusReportedTotal: null,
    requestedGroupKey: "collection",
    requestedLimit: DEFAULT_PAGE_LIMIT,
    expectedPagesFromTotal: null,
    totalCountedByScript: 0,
    stopReason: null,
    paginationWarnings: [],
    paginationDebug: [],
    assetsSeen: 0,
    previousFilterMatchedAssets: 0,
    previousFilterMatchedCards: 0,
    previousFilterMatchedOther: 0,
    previousFilterMatchedVisibleAssets: 0,
    newVisibleAssetsMissedByPreviousFilter: 0,
    newVisibleCardAssetsMissedByPreviousFilter: 0,
    newVisibleOtherAssetsMissedByPreviousFilter: 0,
    allowedCategoryAssets: 0,
    unknownCategoryAssets: 0,
    stagingAssets: 0,
    visibleAfterPublicFilters: 0,
    hiddenOtherAssets: 0,
    duplicatesWithinRunSkipped: 0,
    duplicatesAlreadyExisting: 0,
    wouldInsert: 0,
    wouldUpdate: 0,
    inserted: 0,
    updated: 0,
    categoryCounts: {},
    cardCategoryCounts: {},
    otherCategoryCounts: {},
    assetTypeCounts: {},
    publicGroupCounts: {},
    excluded: {},
    errors: [],
  };
}

function buildTotals(collections: CollectionReport[]) {
  const totals: NftUniverseIngestionReport["totals"] = {
    collectionsProcessed: collections.filter((item) => !item.skippedCollection).length,
    pagesProcessed: 0,
    heliusAssetsSeen: 0,
    previousFilterMatchedAssets: 0,
    previousFilterMatchedCards: 0,
    previousFilterMatchedOther: 0,
    previousFilterMatchedVisibleAssets: 0,
    newVisibleAssetsMissedByPreviousFilter: 0,
    newVisibleCardAssetsMissedByPreviousFilter: 0,
    newVisibleOtherAssetsMissedByPreviousFilter: 0,
    allowedCategoryAssets: 0,
    unknownCategoryAssets: 0,
    stagingAssets: 0,
    visibleAfterPublicFilters: 0,
    hiddenOtherAssets: 0,
    duplicatesWithinRunSkipped: 0,
    duplicatesAlreadyExisting: 0,
    wouldInsert: 0,
    wouldUpdate: 0,
    inserted: 0,
    updated: 0,
    categoryCounts: {},
    cardCategoryCounts: {},
    otherCategoryCounts: {},
    assetTypeCounts: {},
    publicGroupCounts: {},
    sourceCollectionCounts: {},
    missingImageCount: 0,
    missingNameCount: 0,
    missingOwnerCount: 0,
    excluded: {},
    errors: 0,
  };

  for (const collection of collections) {
    totals.pagesProcessed += collection.pagesScanned;
    totals.heliusAssetsSeen += collection.assetsSeen;
    totals.previousFilterMatchedAssets += collection.previousFilterMatchedAssets;
    totals.previousFilterMatchedCards += collection.previousFilterMatchedCards;
    totals.previousFilterMatchedOther += collection.previousFilterMatchedOther;
    totals.previousFilterMatchedVisibleAssets += collection.previousFilterMatchedVisibleAssets;
    totals.newVisibleAssetsMissedByPreviousFilter += collection.newVisibleAssetsMissedByPreviousFilter;
    totals.newVisibleCardAssetsMissedByPreviousFilter += collection.newVisibleCardAssetsMissedByPreviousFilter;
    totals.newVisibleOtherAssetsMissedByPreviousFilter += collection.newVisibleOtherAssetsMissedByPreviousFilter;
    totals.allowedCategoryAssets += collection.allowedCategoryAssets;
    totals.unknownCategoryAssets += collection.unknownCategoryAssets;
    totals.stagingAssets += collection.stagingAssets;
    totals.visibleAfterPublicFilters += collection.visibleAfterPublicFilters;
    totals.hiddenOtherAssets += collection.hiddenOtherAssets;
    totals.duplicatesWithinRunSkipped += collection.duplicatesWithinRunSkipped;
    totals.duplicatesAlreadyExisting += collection.duplicatesAlreadyExisting;
    totals.wouldInsert += collection.wouldInsert;
    totals.wouldUpdate += collection.wouldUpdate;
    totals.inserted += collection.inserted;
    totals.updated += collection.updated;
    totals.errors += collection.errors.length;
    for (const [key, value] of Object.entries(collection.categoryCounts)) addCount(totals.categoryCounts, key, value);
    for (const [key, value] of Object.entries(collection.cardCategoryCounts)) addCount(totals.cardCategoryCounts, key, value);
    for (const [key, value] of Object.entries(collection.otherCategoryCounts)) addCount(totals.otherCategoryCounts, key, value);
    for (const [key, value] of Object.entries(collection.assetTypeCounts)) addCount(totals.assetTypeCounts, key, value);
    for (const [key, value] of Object.entries(collection.publicGroupCounts)) addCount(totals.publicGroupCounts, key, value);
    for (const [key, value] of Object.entries(collection.excluded)) addCount(totals.excluded, key, value);
    addCount(totals.sourceCollectionCounts, collection.collectionAddress, collection.assetsSeen);
  }
  return totals;
}

function writeReport(report: Omit<NftUniverseIngestionReport, "reportPath">, prefix: string) {
  mkdirSync(reportDirectory(), { recursive: true });
  const path = reportPath(prefix);
  const fullReport = { ...report, reportPath: path };
  writeFileSync(path, JSON.stringify(fullReport, null, 2));
  return fullReport;
}

export function getLatestNftIngestionReportPath() {
  return latestReportPath("nft-ingestion-");
}

export function getLatestNftUniverseComparisonReportPath() {
  return latestReportPath("nft-universe-dryrun-");
}

export async function ingestAllowedCollections(options: IngestAllowedCollectionsOptions = {}): Promise<NftUniverseIngestionReport> {
  const countOnly = options.countOnly ?? false;
  const dryRun = countOnly ? true : options.dryRun ?? true;
  const debugPagination = options.debugPagination ?? false;
  const delayMs = Math.max(Math.trunc(options.delayMs ?? 30_000), 0);
  const pageLimit = DEFAULT_PAGE_LIMIT;
  const limitPages = options.limitPages ?? null;
  const limitAssets = options.limitAssets ?? null;
  const includeStaging = options.includeStaging ?? false;
  const storeRaw = options.storeRaw ?? false;
  const compareUniverse = options.compareUniverse ?? true;
  const resume = options.resume ?? true;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const existingAssets = loadExistingAssets();
  const seenMints = new Set<string>();

  const collections = getAllowedNftCollections().filter((collection) => {
    if (!options.collection) return true;
    return collection.collectionAddress === options.collection || normalizeCollectionKey(collection) === options.collection || collection.label === options.collection;
  });

  if (!dryRun) updateIngestionState({ running: true, inserted: 0, updated: 0, duplicatesSkipped: 0 });

  const collectionReports: CollectionReport[] = [];
  let totalProcessedAssets = 0;
  let inserted = 0;
  let updated = 0;
  let duplicatesSkipped = 0;

  try {
    for (const collection of collections) {
      const collectionReport = initCollectionReport(collection);
      collectionReports.push(collectionReport);

    if (collectionReport.stagingCollection && !includeStaging) {
      collectionReport.skippedCollection = true;
      collectionReport.stopReason = "staging_collection";
      addCount(collectionReport.excluded, "staging_collection");
      continue;
    }

      let page = 1;
      while (true) {
        if (limitPages && collectionReport.pagesScanned >= limitPages) {
          collectionReport.stopReason = "page reached maxPages";
          break;
        }
        if (limitAssets && totalProcessedAssets >= limitAssets) {
          collectionReport.stopReason = "maxAssets reached";
          break;
        }

        if (!dryRun) updateIngestionState({
          running: true,
          currentCollection: collection.collectionAddress,
          currentPage: page,
          inserted,
          updated,
          duplicatesSkipped,
        });
        console.log(`[COLLECTION INGESTION] Fetching collection: ${collection.collectionAddress}`);
        console.log(`[COLLECTION INGESTION] Page ${page}`);

        let result: HeliusPage;
        try {
          result = await heliusAssetsPage(collection.collectionAddress, page, pageLimit);
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown error";
          collectionReport.errors.push(message);
          collectionReport.stopReason = "API error";
          if (!dryRun) updateIngestionState({ running: true, lastError: message, inserted, updated, duplicatesSkipped });
          break;
        }

        collectionReport.pagesScanned += 1;
        collectionReport.heliusReportedTotal = result.total;
        collectionReport.expectedPagesFromTotal = typeof result.total === "number" ? Math.ceil(result.total / pageLimit) : null;
        console.log(`[COLLECTION INGESTION] Assets found: ${result.items.length}`);

        let newMintsThisPage = 0;
        for (const raw of result.items) {
          if (limitAssets && totalProcessedAssets >= limitAssets) break;
          collectionReport.assetsSeen += 1;
          totalProcessedAssets += 1;

          const candidate = normalizeNftUniverseAsset(raw, collection);
          if (!candidate) {
            addCount(collectionReport.excluded, "missing_mint");
            continue;
          }

          if (seenMints.has(candidate.mint)) {
            collectionReport.duplicatesWithinRunSkipped += 1;
            duplicatesSkipped += 1;
            continue;
          }
          seenMints.add(candidate.mint);
          newMintsThisPage += 1;

          if (candidate.previousFilterMatched) collectionReport.previousFilterMatchedAssets += 1;
          if (candidate.previousFilterMatchedCard) collectionReport.previousFilterMatchedCards += 1;
          if (candidate.previousFilterMatchedOther) collectionReport.previousFilterMatchedOther += 1;
          if (candidate.category === "unknown") {
            collectionReport.unknownCategoryAssets += 1;
            addCount(collectionReport.excluded, "unknown_category");
          }
          if (candidate.assetType !== "card") {
            collectionReport.hiddenOtherAssets += 1;
            addCount(collectionReport.excluded, "other_asset_type");
          }
          if (candidate.isStaging) {
            collectionReport.stagingAssets += 1;
            addCount(collectionReport.excluded, "staging_asset");
          }
          if (!isAllowedRwaNftCategory(candidate.category)) {
            addCount(collectionReport.excluded, "category_not_allowed");
          } else {
            collectionReport.allowedCategoryAssets += 1;
          }
          if (!candidate.image) addCount(collectionReport.excluded, "missing_image");
          if (!candidate.name) addCount(collectionReport.excluded, "missing_name");
          if (!candidate.owner) addCount(collectionReport.excluded, "missing_owner");
          addCount(collectionReport.categoryCounts, candidate.category);
          addCount(collectionReport.assetTypeCounts, candidate.assetType);
          addCount(collectionReport.publicGroupCounts, candidate.publicGroup);
          if (candidate.assetType === "card") addCount(collectionReport.cardCategoryCounts, candidate.category);
          else addCount(collectionReport.otherCategoryCounts, candidate.category);

          const publiclyVisible = candidate.assetType === "card" && isAllowedRwaNftCategory(candidate.category) && candidate.category !== "unknown" && !candidate.isStaging;
          if (publiclyVisible) collectionReport.visibleAfterPublicFilters += 1;
          if (publiclyVisible && candidate.previousFilterMatched) collectionReport.previousFilterMatchedVisibleAssets += 1;
          if (publiclyVisible && !candidate.previousFilterMatched) {
            collectionReport.newVisibleAssetsMissedByPreviousFilter += 1;
            if (candidate.assetType === "card") collectionReport.newVisibleCardAssetsMissedByPreviousFilter += 1;
            else collectionReport.newVisibleOtherAssetsMissedByPreviousFilter += 1;
          }

          const exists = existingAssets.has(candidate.mint);
          if (exists) {
            collectionReport.duplicatesAlreadyExisting += 1;
            collectionReport.wouldUpdate += 1;
          } else {
            collectionReport.wouldInsert += 1;
          }

          if (!dryRun) {
            upsertNftAsset(candidate, { storeRaw });
            if (exists) {
              collectionReport.updated += 1;
              updated += 1;
            } else {
              collectionReport.inserted += 1;
              inserted += 1;
              existingAssets.set(candidate.mint, { mint: candidate.mint, updated_at: nowIso() });
            }
          }
        }
        collectionReport.totalCountedByScript = collectionReport.assetsSeen;

        const debugEntry: PaginationDebugEntry = {
          collection: collection.label,
          groupKey: "collection",
          groupValue: collection.collectionAddress,
          requestedPage: page,
          requestedLimit: pageLimit,
          resultPage: result.page,
          resultLimit: result.limit,
          resultTotal: result.total,
          itemsLength: result.items.length,
          cumulativeCount: collectionReport.assetsSeen,
          totalGreaterThanItemsLength: typeof result.total === "number" && result.total > result.items.length,
          stopCondition: null,
        };
        collectionReport.paginationDebug.push(debugEntry);
        if (debugPagination) {
          console.log(`[PAGINATION DEBUG] collection=${collection.label} page=${page} limit=${pageLimit} result.total=${result.total ?? "null"} items=${result.items.length} cumulative=${collectionReport.assetsSeen}`);
        }
        console.log(`[COLLECTION INGESTION] Progress collection=${collection.label} page=${page} pageAssets=${result.items.length} collectionAssets=${collectionReport.assetsSeen} globalAssets=${totalProcessedAssets} cards=${collectionReport.assetTypeCounts.card ?? 0} sealed=${collectionReport.assetTypeCounts.sealed ?? 0} comics=${collectionReport.assetTypeCounts.comic ?? 0} merch=${collectionReport.assetTypeCounts.merch ?? 0} unknown=${collectionReport.assetTypeCounts.unknown ?? 0} publicVisibleCards=${collectionReport.visibleAfterPublicFilters}`);

        if (result.items.length === 0) {
          debugEntry.stopCondition = "items.length === 0";
          collectionReport.stopReason = "items.length === 0";
          if (debugPagination) console.log(`[PAGINATION DEBUG] stop=${debugEntry.stopCondition}`);
          break;
        }
        if (result.items.length > 0 && newMintsThisPage === 0) {
          debugEntry.stopCondition = "duplicate page";
          collectionReport.stopReason = "duplicate page";
          collectionReport.paginationWarnings.push("page returned items but all mints were already seen in this run");
          if (debugPagination) console.log(`[PAGINATION DEBUG] stop=${debugEntry.stopCondition}`);
          break;
        }
        if (limitPages && collectionReport.pagesScanned >= limitPages) {
          debugEntry.stopCondition = "page reached maxPages";
          collectionReport.stopReason = "page reached maxPages";
          if (debugPagination) console.log(`[PAGINATION DEBUG] stop=${debugEntry.stopCondition}`);
          break;
        }
        if (result.items.length < pageLimit) {
          debugEntry.stopCondition = "items.length < limit";
          collectionReport.stopReason = "items.length < limit";
          if (debugPagination) console.log(`[PAGINATION DEBUG] stop=${debugEntry.stopCondition}`);
          break;
        }
        if (typeof result.total === "number" && page * pageLimit >= result.total) {
          collectionReport.paginationWarnings.push("result.total was reached but the page was full; continuing because Helius total may be capped");
        }
        if (limitAssets && totalProcessedAssets >= limitAssets) {
          debugEntry.stopCondition = "maxAssets reached";
          collectionReport.stopReason = "maxAssets reached";
          break;
        }
        page += 1;
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (collectionReport.pagesScanned === 1 && collectionReport.heliusReportedTotal && collectionReport.heliusReportedTotal > pageLimit) {
        collectionReport.paginationWarnings.push("result.total is greater than one page but only one page was scanned");
      }
      if (collectionReport.assetsSeen === pageLimit) {
        collectionReport.paginationWarnings.push("counted total is exactly the requested page limit; result may be capped");
      }
      if (collectionReport.assetsSeen === pageLimit && collectionReport.stopReason === "page * limit >= total") {
        collectionReport.paginationWarnings.push("collection stopped at 1000 because result.total matched the requested page limit");
      }
    }
  } finally {
    if (!dryRun) updateIngestionState({
      running: false,
      currentCollection: null,
      currentPage: null,
      inserted,
      updated,
      duplicatesSkipped,
    });
  }

  const totals = buildTotals(collectionReports);
  for (const collection of collectionReports) {
    totals.missingImageCount += collection.excluded.missing_image ?? 0;
    totals.missingNameCount += collection.excluded.missing_name ?? 0;
    totals.missingOwnerCount += collection.excluded.missing_owner ?? 0;
  }

  const reportWithoutPath = {
    dryRun,
    countOnly,
    compareUniverse,
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - startedMs,
    duration: `${((Date.now() - startedMs) / 1000).toFixed(1)}s`,
    options: {
      dryRun,
      countOnly,
      debugPagination,
      delayMs,
      resume,
      includeStaging,
      storeRaw,
      compareUniverse,
      collection: options.collection ?? null,
      limitAssets,
      limitPages,
    },
    allowlistedCollections: getAllowedNftCollections().map((collection) => ({
      ...collection,
      key: normalizeCollectionKey(collection),
      stagingCollection: isStagingText(collection.label, collection.collectionAddress),
    })),
    collections: collectionReports,
    paginationDebug: Object.fromEntries(collectionReports.map((collection) => [collection.key, collection.paginationDebug])),
    totals,
    comparison: {
      previousFilterMatchedAssets: totals.previousFilterMatchedAssets,
      previousFilterMatchedCards: totals.previousFilterMatchedCards,
      previousFilterMatchedOther: totals.previousFilterMatchedOther,
      previousFilterMatchedVisibleAssets: totals.previousFilterMatchedVisibleAssets,
      visibleAfterPublicFilters: totals.visibleAfterPublicFilters,
      newVisibleAssetsMissedByPreviousFilter: totals.newVisibleAssetsMissedByPreviousFilter,
      newVisibleCardAssetsMissedByPreviousFilter: totals.newVisibleCardAssetsMissedByPreviousFilter,
      newVisibleOtherAssetsMissedByPreviousFilter: totals.newVisibleOtherAssetsMissedByPreviousFilter,
      difference: totals.visibleAfterPublicFilters - totals.previousFilterMatchedVisibleAssets,
      matchesPreviousFilterInScannedPages: totals.visibleAfterPublicFilters === totals.previousFilterMatchedVisibleAssets,
      note: compareUniverse
        ? "previousFilterMatchedAssets reflects the older attribute-category NFT filter; visibleAfterPublicFilters now requires asset_type=card, allowed category, non-staging, and non-unknown category for scanned pages."
        : "Universe comparison disabled.",
    },
  };

  const prefix = countOnly ? "nft-universe-count" : dryRun && compareUniverse ? "nft-universe-dryrun" : "nft-ingestion";
  const report = writeReport(reportWithoutPath, prefix);
  if (!dryRun) updateIngestionState({
    running: false,
    inserted,
    updated,
    duplicatesSkipped,
    ingestionReportPath: report.reportPath,
    universeReportPath: dryRun && compareUniverse ? report.reportPath : null,
  });
  return report;
}

export function nftDbExtendedStats() {
  const database = getNftDb();
  const allowedPlaceholders = ALLOWED_RWA_NFT_CATEGORIES.map(() => "?").join(", ");
  const allowedParams = [...ALLOWED_RWA_NFT_CATEGORIES];
  const scalar = (sql: string, ...params: unknown[]) => {
    const row = database.prepare(sql).get(...params) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  };
  return {
    nftAssetsTotal: scalar("SELECT COUNT(*) AS count FROM nft_assets"),
    trackedNftsTotal: scalar("SELECT COUNT(*) AS count FROM tracked_nfts"),
    categoryCounts: database.prepare("SELECT COALESCE(category, 'unknown') AS category, COUNT(*) AS count FROM nft_assets GROUP BY COALESCE(category, 'unknown') ORDER BY count DESC").all(),
    unknownCount: scalar("SELECT COUNT(*) AS count FROM nft_assets WHERE category IS NULL OR category = 'unknown'"),
    stagingCount: scalar("SELECT COUNT(*) AS count FROM nft_assets WHERE is_staging = 1"),
    visiblePublicNftCount: scalar(`
      SELECT COUNT(*) AS count FROM nft_assets
      WHERE is_staging = 0
        AND asset_type = 'card'
        AND category IS NOT NULL
        AND category != 'unknown'
        AND category IN (${allowedPlaceholders})
    `, ...allowedParams),
    assetTypeCounts: database.prepare("SELECT COALESCE(asset_type, 'unknown') AS asset_type, COUNT(*) AS count FROM nft_assets GROUP BY COALESCE(asset_type, 'unknown') ORDER BY count DESC").all(),
    publicGroupCounts: database.prepare("SELECT COALESCE(public_group, CASE WHEN asset_type = 'card' THEN 'card' ELSE 'other' END) AS public_group, COUNT(*) AS count FROM nft_assets GROUP BY COALESCE(public_group, CASE WHEN asset_type = 'card' THEN 'card' ELSE 'other' END) ORDER BY count DESC").all(),
    cardCount: scalar("SELECT COUNT(*) AS count FROM nft_assets WHERE asset_type = 'card'"),
    otherCount: scalar("SELECT COUNT(*) AS count FROM nft_assets WHERE COALESCE(public_group, CASE WHEN asset_type = 'card' THEN 'card' ELSE 'other' END) = 'other'"),
    sealedCount: scalar("SELECT COUNT(*) AS count FROM nft_assets WHERE asset_type = 'sealed'"),
    comicCount: scalar("SELECT COUNT(*) AS count FROM nft_assets WHERE asset_type = 'comic'"),
    merchCount: scalar("SELECT COUNT(*) AS count FROM nft_assets WHERE asset_type = 'merch'"),
    unknownAssetTypeCount: scalar("SELECT COUNT(*) AS count FROM nft_assets WHERE asset_type IS NULL OR asset_type = 'unknown'"),
    hiddenOtherNftCount: scalar("SELECT COUNT(*) AS count FROM nft_assets WHERE COALESCE(public_group, CASE WHEN asset_type = 'card' THEN 'card' ELSE 'other' END) = 'other'"),
    hiddenStagingCount: scalar("SELECT COUNT(*) AS count FROM nft_assets WHERE is_staging = 1"),
    hiddenUnknownCategoryCount: scalar("SELECT COUNT(*) AS count FROM nft_assets WHERE category IS NULL OR category = 'unknown'"),
    sourceCollectionCounts: database.prepare("SELECT COALESCE(source_collection, 'unknown') AS source_collection, COUNT(*) AS count FROM nft_assets GROUP BY COALESCE(source_collection, 'unknown') ORDER BY count DESC").all(),
    missingImageCount: scalar("SELECT COUNT(*) AS count FROM nft_assets WHERE image IS NULL OR image = ''"),
    missingNameCount: scalar("SELECT COUNT(*) AS count FROM nft_assets WHERE name IS NULL OR name = ''"),
    missingOwnerCount: scalar("SELECT COUNT(*) AS count FROM nft_assets WHERE owner IS NULL OR owner = ''"),
    duplicateMintCount: scalar("SELECT COUNT(*) AS count FROM (SELECT mint FROM nft_assets GROUP BY mint HAVING COUNT(*) > 1)"),
    latestIngestionReportPath: getLatestNftIngestionReportPath(),
    latestUniverseComparisonReportPath: getLatestNftUniverseComparisonReportPath(),
  };
}

export function formatIngestionSummary(report: NftUniverseIngestionReport) {
  return [
    report.countOnly ? "NFT universe full count:" : "NFT universe dry run:",
    `dryRun: ${report.dryRun}`,
    `countOnly: ${report.countOnly}`,
    `report: ${report.reportPath}`,
    `duration: ${report.duration}`,
    `allowlisted collections: ${report.allowlistedCollections.length}`,
    `collections processed: ${report.totals.collectionsProcessed}`,
    `pages processed: ${report.totals.pagesProcessed}`,
    `Total assets: ${report.totals.heliusAssetsSeen}`,
    `Cards: ${report.totals.assetTypeCounts.card ?? 0}`,
    `Sealed: ${report.totals.assetTypeCounts.sealed ?? 0}`,
    `Comics: ${report.totals.assetTypeCounts.comic ?? 0}`,
    `Merch: ${report.totals.assetTypeCounts.merch ?? 0}`,
    `Unknown type: ${report.totals.assetTypeCounts.unknown ?? 0}`,
    `Public visible cards: ${report.totals.visibleAfterPublicFilters}`,
    `Hidden other: ${report.totals.hiddenOtherAssets}`,
    `Old filter matched: ${report.totals.previousFilterMatchedAssets}`,
    `Difference vs old filter: ${report.comparison.difference}`,
    `asset type counts: ${JSON.stringify(report.totals.assetTypeCounts)}`,
    `public group counts: ${JSON.stringify(report.totals.publicGroupCounts)}`,
    `card-only category counts: ${JSON.stringify(report.totals.cardCategoryCounts)}`,
    `other category counts: ${JSON.stringify(report.totals.otherCategoryCounts)}`,
    `hidden other assets: ${report.totals.hiddenOtherAssets}`,
    `would insert: ${report.totals.wouldInsert}`,
    `would update: ${report.totals.wouldUpdate}`,
    `duplicates in run skipped: ${report.totals.duplicatesWithinRunSkipped}`,
    `already existing assets: ${report.totals.duplicatesAlreadyExisting}`,
    `unknown category: ${report.totals.unknownCategoryAssets}`,
    `staging: ${report.totals.stagingAssets}`,
    `category counts: ${JSON.stringify(report.totals.categoryCounts)}`,
    `excluded: ${JSON.stringify(report.totals.excluded)}`,
    `matches previous filter on scanned pages: ${report.comparison.matchesPreviousFilterInScannedPages}`,
    `comparison difference: ${report.comparison.difference}`,
  ].join("\n");
}
