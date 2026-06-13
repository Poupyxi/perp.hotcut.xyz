import type { ProviderScanStatus } from "@/types/rwaNftMarket";
import { heliusAssetsPage, normalizeNftUniverseAsset } from "./nftCollectionIngestionService";
import { getNftDb, shouldStoreRawHeliusJson, sqliteBool, stringifyJson } from "./nftSqliteDb";
import { readNftScannerConfig } from "./nftScannerConfig";
import { saveProviderScanStatus } from "./nftScannerStatusService";
import { getAllowedNftCollections, type TargetNftCollectionConfig } from "./trackedNftsConfig";

export type DiscoverNewMintsOptions = {
  dryRun?: boolean | null;
  limitPerCollection?: number | null;
  collection?: string | null;
  storeRaw?: boolean;
};

export type DiscoverNewMintsResult = {
  dryRun: boolean;
  discoveryEnabled: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  collectionsChecked: number;
  provider: "helius";
  newMintsFound: number;
  newMintsInserted: number;
  existingMintsSkipped: number;
  wouldInsert: number;
  wouldUpdate: number;
  errors: Array<{ collection: string; error: string }>;
  providerStatuses: ProviderScanStatus[];
  preview: Array<{
    mint: string;
    name: string | null;
    category: string;
    assetType: string;
    sourceCollection: string;
    action: "insert" | "update";
  }>;
};

function nowIso() {
  return new Date().toISOString();
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "unknown";
}

function collectionMatches(collection: TargetNftCollectionConfig, filter: string | null | undefined) {
  if (!filter) return true;
  return collection.collectionAddress === filter || collection.label === filter || slug(collection.label) === filter;
}

function assetExists(mint: string) {
  const row = getNftDb().prepare("SELECT mint FROM nft_assets WHERE mint = ? LIMIT 1").get(mint);
  return Boolean(row);
}

function upsertDiscoveredAsset(candidate: NonNullable<ReturnType<typeof normalizeNftUniverseAsset>>, options: { storeRaw?: boolean }) {
  const timestamp = nowIso();
  getNftDb().prepare(`
    INSERT INTO nft_assets (
      id, mint, market, name, description, image, owner, collection, category, attributes_json,
      asset_type, public_group, token_standard, interface, source_collection, source_provider,
      discovered_at, last_seen_at, collection_name, metadata_uri, is_staging, raw_helius_json,
      is_listed, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?)
    ON CONFLICT(mint) DO UPDATE SET
      market = COALESCE(NULLIF(nft_assets.market, ''), excluded.market),
      name = COALESCE(nft_assets.name, excluded.name),
      description = COALESCE(nft_assets.description, excluded.description),
      image = COALESCE(nft_assets.image, excluded.image),
      owner = COALESCE(excluded.owner, nft_assets.owner),
      collection = COALESCE(nft_assets.collection, excluded.collection),
      category = CASE
        WHEN nft_assets.category IS NULL OR nft_assets.category = 'unknown' THEN excluded.category
        ELSE nft_assets.category
      END,
      asset_type = COALESCE(nft_assets.asset_type, excluded.asset_type),
      public_group = COALESCE(nft_assets.public_group, excluded.public_group),
      attributes_json = COALESCE(nft_assets.attributes_json, excluded.attributes_json),
      token_standard = COALESCE(nft_assets.token_standard, excluded.token_standard),
      interface = COALESCE(nft_assets.interface, excluded.interface),
      source_collection = COALESCE(nft_assets.source_collection, excluded.source_collection),
      source_provider = COALESCE(nft_assets.source_provider, excluded.source_provider),
      discovered_at = COALESCE(nft_assets.discovered_at, excluded.discovered_at),
      last_seen_at = excluded.last_seen_at,
      collection_name = COALESCE(nft_assets.collection_name, excluded.collection_name),
      is_staging = excluded.is_staging,
      raw_helius_json = COALESCE(excluded.raw_helius_json, nft_assets.raw_helius_json),
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
    "helius",
    timestamp,
    timestamp,
    candidate.sourceCollectionLabel,
    sqliteBool(candidate.isStaging),
    options.storeRaw || shouldStoreRawHeliusJson() ? stringifyJson(candidate.raw) : null,
    timestamp,
    timestamp,
  );
}

function providerStatus(input: {
  startedAt: string;
  durationMs: number;
  itemsChecked: number;
  itemsFound: number;
  itemsStored: number;
  errors: number;
}): ProviderScanStatus {
  return {
    provider: "helius",
    scanType: "new_mints",
    status: input.errors > 0 ? "error" : "live",
    lastRunAt: input.startedAt,
    lastSuccessAt: input.errors > 0 ? null : nowIso(),
    lastError: input.errors > 0 ? `${input.errors} collection(s) failed` : null,
    itemsChecked: input.itemsChecked,
    itemsFound: input.itemsFound,
    itemsStored: input.itemsStored,
    durationMs: input.durationMs,
  };
}

export async function discoverNewMintsFromTrackedCollections(options: DiscoverNewMintsOptions = {}): Promise<DiscoverNewMintsResult> {
  const config = readNftScannerConfig({ dryRun: options.dryRun });
  const startedAt = nowIso();
  const startedMs = Date.now();
  const limitPerCollection = Math.min(
    Math.max(Math.trunc(options.limitPerCollection ?? config.newMintDiscoveryLimitPerCollection), 1),
    1000,
  );
  const collections = config.newMintDiscoveryEnabled
    ? getAllowedNftCollections().filter((collection) => collectionMatches(collection, options.collection))
    : [];
  const preview: DiscoverNewMintsResult["preview"] = [];
  const errors: DiscoverNewMintsResult["errors"] = [];
  let newMintsFound = 0;
  let newMintsInserted = 0;
  let existingMintsSkipped = 0;
  let wouldInsert = 0;
  let wouldUpdate = 0;

  console.log(`[NFT DISCOVERY] Starting new mint discovery dryRun=${config.dryRun} limitPerCollection=${limitPerCollection}`);

  for (const collection of collections) {
    try {
      const page = await heliusAssetsPage(collection.collectionAddress, 1, limitPerCollection);
      console.log(`[NFT DISCOVERY] ${collection.label} ${collection.collectionAddress}: ${page.items.length} asset(s) returned`);

      for (const raw of page.items) {
        const candidate = normalizeNftUniverseAsset(raw, collection);
        if (!candidate) continue;
        const exists = assetExists(candidate.mint);
        const action = exists ? "update" : "insert";
        newMintsFound += exists ? 0 : 1;
        existingMintsSkipped += exists ? 1 : 0;
        wouldInsert += exists ? 0 : 1;
        wouldUpdate += exists ? 1 : 0;

        if (preview.length < 25) {
          preview.push({
            mint: candidate.mint,
            name: candidate.name,
            category: candidate.category,
            assetType: candidate.assetType,
            sourceCollection: candidate.sourceCollection,
            action,
          });
        }

        if (config.dryRun) {
          console.log(`[NFT DISCOVERY][DRY RUN] ${action} ${candidate.mint} ${candidate.name ?? ""}`);
        } else {
          upsertDiscoveredAsset(candidate, { storeRaw: options.storeRaw });
          if (!exists) newMintsInserted += 1;
        }
      }
    } catch (error) {
      errors.push({ collection: collection.collectionAddress, error: error instanceof Error ? error.message : "Discovery failed" });
    }
  }

  const durationMs = Date.now() - startedMs;
  const scanStatus = providerStatus({
    startedAt,
    durationMs,
    itemsChecked: collections.length,
    itemsFound: newMintsFound + existingMintsSkipped,
    itemsStored: newMintsInserted,
    errors: errors.length,
  });
  saveProviderScanStatus(scanStatus, { dryRun: config.dryRun });

  const finishedAt = nowIso();
  console.log(`[NFT DISCOVERY] Completed collections=${collections.length} found=${newMintsFound} inserted=${newMintsInserted} existing=${existingMintsSkipped} errors=${errors.length}`);

  return {
    dryRun: config.dryRun,
    discoveryEnabled: config.newMintDiscoveryEnabled,
    startedAt,
    finishedAt,
    durationMs,
    collectionsChecked: collections.length,
    provider: "helius",
    newMintsFound,
    newMintsInserted,
    existingMintsSkipped,
    wouldInsert,
    wouldUpdate,
    errors,
    providerStatuses: [scanStatus],
    preview,
  };
}
