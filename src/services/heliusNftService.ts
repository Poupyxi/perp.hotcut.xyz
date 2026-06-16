import type { CollectionIngestionResult, NormalizedNftAsset, TrackedNftRow } from "./nftTypes";
import { readNftDb, saveCollectionAssets, saveNormalizedAsset, updateQueueState } from "./nftStore";
import { filterAndSortTrackedAssets, getTrackedMarketCategory } from "./trackedMarketCategories";
import { findAllowedNftCollection } from "./trackedNftsConfig";
import { fetchWithHeliusKey, hasHeliusApiKey, isHeliusKeysUnavailableError } from "./heliusApiKeyRotation";

const HELIUS_RPC_URL = "https://mainnet.helius-rpc.com/";
const DEFAULT_COLLECTION_LIMIT = 1000;
const COLLECTION_HELIUS_CALL_INTERVAL_MS = 30_000;
const COLLECTION_HELIUS_RATE_LIMIT_BACKOFF_MS = 60_000;

type HeliusJsonRpcResponse = {
  result?: unknown;
  error?: { code?: number; message?: string };
};

type GetAssetsByCollectionOptions = {
  page?: number;
  limit?: number;
  maxPages?: number;
};

function env() {
  return (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

function now() {
  return Date.now();
}

function timeMs(iso: string | null | undefined) {
  return iso ? new Date(iso).getTime() : 0;
}

function remainingMs(timestamp: string | null | undefined, intervalMs: number) {
  const elapsed = now() - timeMs(timestamp);
  return Math.max(intervalMs - elapsed, 0);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCollectionRateLimit() {
  const db = await readNftDb();
  const backoff = remainingMs(db.queue_state.backoffUntil, 0);
  if (backoff > 0) return backoff;
  return remainingMs(db.queue_state.lastHeliusCallAt, COLLECTION_HELIUS_CALL_INTERVAL_MS);
}

async function markCollectionHeliusCall() {
  await updateQueueState((db) => ({ ...db, queue_state: { ...db.queue_state, lastHeliusCallAt: new Date().toISOString(), backoffUntil: null } }));
}

async function markCollectionBackoff() {
  const backoffUntil = new Date(now() + COLLECTION_HELIUS_RATE_LIMIT_BACKOFF_MS).toISOString();
  await updateQueueState((db) => ({ ...db, queue_state: { ...db.queue_state, backoffUntil } }));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function attributesFromMetadata(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function rowsFromAssetsByGroupResult(value: unknown): unknown[] {
  const result = asRecord(value);
  return Array.isArray(result.items) ? result.items : [];
}

function totalFromAssetsByGroupResult(value: unknown): number | null {
  const result = asRecord(value);
  return typeof result.total === "number" ? result.total : null;
}

export class HeliusNftError extends Error {
  status?: number;
  rateLimited: boolean;

  constructor(message: string, options: { status?: number; rateLimited?: boolean } = {}) {
    super(message);
    this.name = "HeliusNftError";
    this.status = options.status;
    this.rateLimited = Boolean(options.rateLimited);
  }
}

async function heliusRpc(method: string, params: unknown, id: string): Promise<unknown> {
  if (!hasHeliusApiKey()) {
    console.log("[NFT INGESTION] Missing HELIUS_API_KEY");
    throw new HeliusNftError("Missing HELIUS_API_KEY");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchWithHeliusKey({
      label: `nft-ingestion:${method}`,
      endpoint: HELIUS_RPC_URL,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      },
    });

    if (response.status === 429) throw new HeliusNftError("Helius rate limit hit", { status: 429, rateLimited: true });
    if (!response.ok) throw new HeliusNftError(`Helius request failed: ${response.status} ${response.statusText}`, { status: response.status });

    const payload = await response.json() as HeliusJsonRpcResponse;
    if (payload.error) throw new HeliusNftError(payload.error.message || `Helius ${method} returned an error`);
    if (!payload.result) throw new HeliusNftError(`Helius ${method} returned no result`);
    return payload.result;
  } catch (error) {
    if (error instanceof HeliusNftError) throw error;
    if (isHeliusKeysUnavailableError(error)) throw new HeliusNftError(error.message, { status: 429, rateLimited: true });
    if (error instanceof Error && error.name === "AbortError") throw new HeliusNftError("Helius request timed out");
    throw new HeliusNftError(error instanceof Error ? error.message : "Helius network error");
  } finally {
    clearTimeout(timeout);
  }
}

export async function getAssetByMint(mint: string): Promise<unknown> {
  return heliusRpc("getAsset", { id: mint }, "get-asset");
}

export function normalizeHeliusAsset(asset: any, market = "unknown"): NormalizedNftAsset {
  const record = asRecord(asset);
  const content = asRecord(record.content);
  const metadata = asRecord(content.metadata);
  const links = asRecord(content.links);
  const ownership = asRecord(record.ownership);
  const tokenInfo = asRecord(record.token_info);
  const grouping = Array.isArray(record.grouping) ? record.grouping.map(asRecord) : [];
  const collectionGroup = grouping.find((group) => group.group_key === "collection");
  const mint = asString(record.id);

  if (!mint) throw new HeliusNftError("Invalid Helius asset: missing id");

  return {
    mint,
    name: asString(metadata.name),
    description: asString(metadata.description),
    image: asString(links.image),
    owner: asString(ownership.owner),
    collection: asString(collectionGroup?.group_value),
    market,
    attributes: attributesFromMetadata(metadata.attributes),
    tokenStandard: asString(tokenInfo.token_program) ?? asString(record.interface),
    interface: asString(record.interface),
    rawSource: "helius",
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeTrackedHeliusAsset(asset: any, fallbackMarket = "unknown"): NormalizedNftAsset | null {
  const normalized = normalizeHeliusAsset(asset, fallbackMarket);
  const category = getTrackedMarketCategory(normalized.attributes);
  return category ? { ...normalized, market: category.market } : null;
}

export async function getAssetsByCollection(collectionAddress: string, options: GetAssetsByCollectionOptions = {}): Promise<{ assets: unknown[]; pagesFetched: number; total: number | null }> {
  const allowedCollection = findAllowedNftCollection(collectionAddress);
  if (!allowedCollection) {
    throw new HeliusNftError("Collection is not allowlisted. Refusing to fetch unknown collection.");
  }

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_COLLECTION_LIMIT, 1), DEFAULT_COLLECTION_LIMIT);
  let page = Math.max(options.page ?? 1, 1);
  let pagesFetched = 0;
  let total: number | null = null;
  const assets: unknown[] = [];

  console.log(`[COLLECTION INGESTION] Fetching collection: ${allowedCollection.collectionAddress}`);

  while (true) {
    const waitMs = await waitForCollectionRateLimit();
    if (waitMs > 0) await sleep(waitMs);

    console.log(`[COLLECTION INGESTION] Page ${page}`);
    let result: unknown;
    try {
      await markCollectionHeliusCall();
      result = await heliusRpc("getAssetsByGroup", {
        groupKey: "collection",
        groupValue: allowedCollection.collectionAddress,
        page,
        limit,
      }, "get-assets-by-group");
    } catch (error) {
      if (error instanceof HeliusNftError && error.rateLimited) {
        console.log("[COLLECTION INGESTION] Helius rate limit hit, backing off");
        await markCollectionBackoff();
      }
      throw error;
    }

    const rows = rowsFromAssetsByGroupResult(result);
    total = totalFromAssetsByGroupResult(result);
    console.log(`[COLLECTION INGESTION] Assets found: ${rows.length}`);
    assets.push(...rows);
    pagesFetched += 1;

    if (!rows.length) break;
    if (typeof total === "number" && page * limit >= total) break;
    if (options.maxPages && pagesFetched >= options.maxPages) break;
    if (rows.length < limit) break;
    page += 1;
  }

  return { assets, pagesFetched, total };
}

export async function fetchAndSaveAllowedCollection(collectionAddress: string, options: GetAssetsByCollectionOptions = {}): Promise<CollectionIngestionResult> {
  const allowedCollection = findAllowedNftCollection(collectionAddress);
  if (!allowedCollection) throw new HeliusNftError("Collection is not allowlisted. Refusing to fetch unknown collection.");

  const { assets, pagesFetched } = await getAssetsByCollection(allowedCollection.collectionAddress, options);
  const pairs = assets
    .map((asset) => ({ raw: asset, normalized: normalizeTrackedHeliusAsset(asset, allowedCollection.market) }))
    .filter((item): item is { raw: unknown; normalized: NormalizedNftAsset } => Boolean(item.normalized));
  const normalized = filterAndSortTrackedAssets(pairs.map((item) => item.normalized));
  const rawByMint = new Map(pairs.map((item) => [item.normalized.mint, item.raw]));
  const filteredRawAssets = normalized.map((asset) => rawByMint.get(asset.mint) ?? asset);
  const saved = await saveCollectionAssets(allowedCollection, normalized, filteredRawAssets);

  console.log(`[COLLECTION INGESTION] Skipped assets outside tracked categories: ${assets.length - normalized.length}`);
  console.log(`[COLLECTION INGESTION] Saved assets: ${saved.savedAssets}`);

  return {
    collectionAddress: allowedCollection.collectionAddress,
    market: allowedCollection.market,
    label: allowedCollection.label,
    pagesFetched,
    assetsFound: assets.length,
    savedAssets: saved.savedAssets,
    skippedAssets: assets.length - normalized.length,
    nextPage: null,
  };
}

export async function fetchTrackedNft(trackedNft: TrackedNftRow) {
  console.log(`[NFT INGESTION] Fetching mint: ${trackedNft.mint}`);
  const raw = await getAssetByMint(trackedNft.mint);
  const normalized = normalizeHeliusAsset(raw, trackedNft.market);
  const saved = await saveNormalizedAsset(trackedNft, normalized, raw);
  console.log(`[NFT INGESTION] Saved asset: ${trackedNft.mint}`);
  return { normalized, saved, raw };
}
