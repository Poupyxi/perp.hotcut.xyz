type RuntimeEnv = Record<string, string | undefined>;

export type NftScannerConfig = {
  dryRun: boolean;
  enabled: boolean;
  batchSize: number;
  intervalSeconds: number;
  maxRetries: number;
  newMintDiscoveryEnabled: boolean;
  newMintDiscoveryIntervalSeconds: number;
  newMintDiscoveryLimitPerCollection: number;
  nftListEnrichBatchSize: number;
  nftListEnrichMaxRetries: number;
  nftListEnrichDryRun: boolean;
  nftListEnrichFocusMint: string | null;
  nftListEnrichTtlSeconds: number;
  nftListEnrichRefreshCooldownSeconds: number;
  trackedCollections: string[];
  magicEdenCollectionSymbols: string[];
  tensorCollectionSlugs: string[];
  phygitalsCollectionIds: string[];
  collectorCryptCollectionIds: string[];
  beezieCollectionIds: string[];
  packOpeningProgramIds: string[];
  packOpeningAuthorityAddresses: string[];
  packOpeningCollectionAddresses: string[];
  packOpeningKeywords: string[];
};

function env(): RuntimeEnv {
  return (globalThis as unknown as { process?: { env?: RuntimeEnv } }).process?.env ?? {};
}

function boolEnv(name: string, fallback: boolean) {
  const value = env()[name];
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function numberEnv(name: string, fallback: number, min = 1) {
  const parsed = Number(env()[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(Math.trunc(parsed), min);
}

function csvEnv(name: string, fallback: string[] = []) {
  const raw = env()[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function stringEnv(name: string) {
  const value = env()[name]?.trim();
  return value ? value : null;
}

export function isNftScannerDryRun(requestedDryRun?: boolean | null) {
  const envDryRun = env().NFT_SCANNER_DRY_RUN !== "false";
  if (requestedDryRun === true) return true;
  if (requestedDryRun === false) return envDryRun;
  return envDryRun;
}

export function readNftScannerConfig(input: { dryRun?: boolean | null } = {}): NftScannerConfig {
  const nftListDryRun = env().NFT_LIST_ENRICH_DRY_RUN
    ? env().NFT_LIST_ENRICH_DRY_RUN !== "false"
    : isNftScannerDryRun(input.dryRun);
  return {
    dryRun: isNftScannerDryRun(input.dryRun),
    enabled: boolEnv("ENABLE_NFT_SCANNER", true),
    batchSize: numberEnv("NFT_SCANNER_BATCH_SIZE", 25),
    intervalSeconds: numberEnv("NFT_SCANNER_INTERVAL_SECONDS", 600),
    maxRetries: numberEnv("NFT_SCANNER_MAX_RETRIES", 3),
    newMintDiscoveryEnabled: boolEnv("ENABLE_NEW_MINT_DISCOVERY", true),
    newMintDiscoveryIntervalSeconds: numberEnv("NEW_MINT_DISCOVERY_INTERVAL_SECONDS", 1800),
    newMintDiscoveryLimitPerCollection: numberEnv("NEW_MINT_DISCOVERY_LIMIT_PER_COLLECTION", 500),
    nftListEnrichBatchSize: numberEnv("NFT_LIST_ENRICH_BATCH_SIZE", 50),
    nftListEnrichMaxRetries: numberEnv("NFT_LIST_ENRICH_MAX_RETRIES", 3),
    nftListEnrichDryRun: input.dryRun === true ? true : input.dryRun === false ? nftListDryRun : nftListDryRun,
    nftListEnrichFocusMint: stringEnv("NFT_LIST_ENRICH_FOCUS_MINT"),
    nftListEnrichTtlSeconds: numberEnv("NFT_LIST_ENRICH_TTL_SECONDS", 600),
    nftListEnrichRefreshCooldownSeconds: numberEnv("NFT_LIST_ENRICH_REFRESH_COOLDOWN_SECONDS", 30),
    trackedCollections: csvEnv("TRACKED_COLLECTIONS", ["pokemon-cards", "one-piece-cards", "nba-cards", "nfl-cards", "nhl-cards"]),
    magicEdenCollectionSymbols: csvEnv("MAGIC_EDEN_COLLECTION_SYMBOLS"),
    tensorCollectionSlugs: csvEnv("TENSOR_COLLECTION_SLUGS"),
    phygitalsCollectionIds: csvEnv("PHYGITALS_COLLECTION_IDS"),
    collectorCryptCollectionIds: csvEnv("COLLECTOR_CRYPT_COLLECTION_IDS"),
    beezieCollectionIds: csvEnv("BEEZIE_COLLECTION_IDS"),
    packOpeningProgramIds: csvEnv("PACK_OPENING_PROGRAM_IDS", [
      "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
      "phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC",
    ]),
    packOpeningAuthorityAddresses: csvEnv("PACK_OPENING_AUTHORITY_ADDRESSES"),
    packOpeningCollectionAddresses: csvEnv("PACK_OPENING_COLLECTION_ADDRESSES"),
    packOpeningKeywords: csvEnv("PACK_OPENING_KEYWORDS", ["pack", "open", "opened", "reveal", "claim", "redeem", "redeemed"]),
  };
}

export function scannerWriteAllowed(requestedDryRun?: boolean | null) {
  return !isNftScannerDryRun(requestedDryRun);
}

export function providerApiEnv() {
  return {
    heliusConfigured: Boolean(env().HELIUS_API_KEY),
    shyftConfigured: Boolean(env().SHYFT_API_KEY),
    solscanConfigured: Boolean(env().SOLSCAN_API_KEY),
    magicEdenConfigured: boolEnv("MAGIC_EDEN_ENABLED", false) && Boolean(env().MAGIC_EDEN_API_KEY || env().MAGIC_EDEN_API_URL),
    magicEdenEnabled: boolEnv("MAGIC_EDEN_ENABLED", false),
    tensorConfigured: Boolean(env().TENSOR_API_KEY),
    phygitalsConfigured: boolEnv("PHYGITALS_ENABLED", false) && Boolean(env().PHYGITALS_API_URL),
    phygitalsEnabled: boolEnv("PHYGITALS_ENABLED", false),
    collectorCryptConfigured: boolEnv("COLLECTOR_CRYPT_ENABLED", false) && Boolean(env().COLLECTOR_CRYPT_API_URL),
    collectorCryptEnabled: boolEnv("COLLECTOR_CRYPT_ENABLED", false),
    beezieConfigured: Boolean(env().BEEZIE_API_URL || env().BEEZIE_CHAIN_IDS || env().BEEZIE_PROGRAM_IDS),
  };
}
