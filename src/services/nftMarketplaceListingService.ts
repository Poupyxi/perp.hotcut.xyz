import type { DatabaseSync } from "node:sqlite";
import { getNftDb } from "./nftSqliteDb";

type ListingProviderId = "magic-eden" | "tensor" | "phygitals" | "collector-crypt";
type RuntimeEnv = Record<string, string | undefined>;
type ProviderCheckStatus = "found" | "not_found" | "needs_api_key" | "needs_endpoint" | "disabled" | "error";

export type ProviderCheck = {
  providerId: ListingProviderId;
  status: ProviderCheckStatus;
  message: string;
};

export type ActiveMintListing = {
  providerId: ListingProviderId;
  marketplace: string | null;
  priceSol: number | null;
  priceUsd: number | null;
  listedAt: string | null;
  rawPayload: unknown;
};

/**
 * Definitive listing verification result — independent of scan priority.
 *
 * unknown            — no check has ever been performed (initial / no-provider state)
 * verified_listed    — a provider confirmed an active listing
 * verified_unlisted  — a provider ran and found no listing (confirmed absent)
 * provider_unavailable — all configured providers were disabled or unconfigured;
 *                        no actual marketplace check was made; existing DB state must
 *                        be preserved — do NOT write is_listed = 0
 */
export type ListingVerificationStatus =
  | "unknown"
  | "verified_listed"
  | "verified_unlisted"
  | "provider_unavailable";

export type ActiveMintListingLookupResult = {
  mint: string;
  found: boolean;
  listing: ActiveMintListing | null;
  providersChecked: ProviderCheck[];
  reason: string;
  /** Derived from which providers actually ran. */
  verificationStatus: ListingVerificationStatus;
};

function env(): RuntimeEnv {
  return (globalThis as unknown as { process?: { env?: RuntimeEnv } }).process?.env ?? {};
}

function providerEnabled(name: "MAGIC_EDEN_ENABLED" | "PHYGITALS_ENABLED" | "COLLECTOR_CRYPT_ENABLED") {
  return (env()[name] ?? "false") === "true";
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toIsoDate(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  return null;
}

function rowsFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.items)) return record.items;
  if (Array.isArray(record.results)) return record.results;
  if (Array.isArray(record.listings)) return record.listings;
  if (Array.isArray(record.result)) return record.result;
  return [];
}

function marketplaceFromValue(value: unknown, fallback: string): string {
  const text = asString(value)?.toLowerCase() ?? "";
  if (text.includes("tensor")) return "Tensor";
  if (text.includes("phygital")) return "Phygitals";
  if (text.includes("collector")) return "Collector Crypt";
  if (text.includes("magiceden") || text.includes("magic_eden") || text === "mmm") return "Magic Eden";
  return asString(value) ?? fallback;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; payload: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok && response.status !== 404) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return { status: response.status, payload };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeListing(providerId: ListingProviderId, fallbackMarketplace: string, raw: unknown): ActiveMintListing | null {
  const row = asRecord(raw);
  if (!Object.keys(row).length) return null;

  const priceUsd = asNumber(row.priceUsd) ?? asNumber(row.price_usd) ?? asNumber(row.usdPrice) ?? asNumber(row.usd_price);
  const priceSol =
    asNumber(row.priceSol)
    ?? asNumber(row.price_sol)
    ?? (priceUsd == null ? asNumber(row.price) ?? asNumber(row.listedPrice) ?? asNumber(row.listed_price) ?? asNumber(row.amount) : null);

  const marketplace = marketplaceFromValue(
    row.marketplace ?? row.source ?? row.marketplaceName ?? row.marketplace_name,
    fallbackMarketplace,
  );

  const listedAt =
    toIsoDate(row.listedAt)
    ?? toIsoDate(row.listed_at)
    ?? toIsoDate(row.createdAt)
    ?? toIsoDate(row.created_at)
    ?? toIsoDate(row.updatedAt)
    ?? toIsoDate(row.updated_at)
    ?? toIsoDate(row.timestamp)
    ?? toIsoDate(row.blockTime)
    ?? toIsoDate(row.block_time);

  if (priceSol == null && priceUsd == null && !listedAt && !marketplace) return null;

  return {
    providerId,
    marketplace,
    priceSol,
    priceUsd,
    listedAt,
    rawPayload: raw,
  };
}

async function fetchCollectorCryptListingFromSnapshot(mint: string): Promise<ActiveMintListing | null> {
  if (!providerEnabled("COLLECTOR_CRYPT_ENABLED")) return null;

  try {
    const db = getNftDb();
    const row = db
      .prepare(
        `SELECT listing_id, marketplace, listing_price, listing_currency, seller, listed_at, raw_payload_json
         FROM collector_crypt_listings
         WHERE mint = ? AND is_current_snapshot = 1 AND listing_status = 'active'
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(mint) as {
      listing_id?: string;
      marketplace?: string;
      listing_price?: number;
      listing_currency?: string;
      seller?: string;
      listed_at?: string;
      raw_payload_json?: string;
    } | undefined;

    if (!row) return null;

    return normalizeListing("collector-crypt", row.marketplace || "Collector Crypt", {
      listingId: row.listing_id,
      marketplace: row.marketplace,
      priceSol: row.listing_price,
      listedAt: row.listed_at,
      seller: row.seller,
      rawPayload: row.raw_payload_json ? JSON.parse(row.raw_payload_json) : undefined,
    });
  } catch (error) {
    console.error("[Collector Crypt Snapshot] Error fetching listing:", error);
    return null;
  }
}

async function fetchMagicEdenListing(mint: string): Promise<ActiveMintListing | null> {
  if (!providerEnabled("MAGIC_EDEN_ENABLED")) return null;
  const runtime = env();
  const headers: Record<string, string> = { accept: "application/json" };
  if (runtime.MAGIC_EDEN_API_KEY) headers.Authorization = `Bearer ${runtime.MAGIC_EDEN_API_KEY}`;

  const url = new URL(`https://api-mainnet.magiceden.dev/v2/tokens/${encodeURIComponent(mint)}/listings`);
  url.searchParams.set("listingAggMode", "true");

  const { status, payload } = await fetchJson(url.toString(), { headers });
  if (status === 404) return null;

  for (const row of rowsFromPayload(payload)) {
    const listing = normalizeListing("magic-eden", "Magic Eden", row);
    if (listing) return listing;
  }

  return normalizeListing("magic-eden", "Magic Eden", payload);
}

async function fetchGenericListing(
  providerId: ListingProviderId,
  baseUrlValue: string,
  mint: string,
  options: { apiKey?: string; apiKeyHeader?: "Authorization" | "x-api-key"; mintParam?: string; extraParams?: Record<string, string> },
): Promise<ActiveMintListing | null> {
  const url = new URL(baseUrlValue);
  url.searchParams.set(options.mintParam ?? "mint", mint);
  for (const [key, value] of Object.entries(options.extraParams ?? {})) url.searchParams.set(key, value);

  const headers: Record<string, string> = { accept: "application/json" };
  if (options.apiKey) {
    if (options.apiKeyHeader === "x-api-key") headers["x-api-key"] = options.apiKey;
    else headers.Authorization = `Bearer ${options.apiKey}`;
  }

  const { status, payload } = await fetchJson(url.toString(), { headers });
  if (status === 404) return null;

  for (const row of rowsFromPayload(payload)) {
    const listing = normalizeListing(providerId, marketplaceFromValue(providerId, providerId), row);
    if (listing) return listing;
  }

  return normalizeListing(providerId, marketplaceFromValue(providerId, providerId), payload);
}

/** Derive verification status from which providers actually ran. */
function deriveVerificationStatus(found: boolean, checks: ProviderCheck[]): ListingVerificationStatus {
  if (found) return "verified_listed";
  // A provider "actually ran" only when its status is found or not_found.
  const anyActualCheck = checks.some((c) => c.status === "found" || c.status === "not_found");
  return anyActualCheck ? "verified_unlisted" : "provider_unavailable";
}

export async function lookupActiveListingByMint(mint: string): Promise<ActiveMintListingLookupResult> {
  const runtime = env();
  const providersChecked: ProviderCheck[] = [];

  const tryProvider = async (
    providerId: ListingProviderId,
    action: () => Promise<ActiveMintListing | null>,
    missingConfig?: ProviderCheck | null,
  ): Promise<ActiveMintListing | null> => {
    if (missingConfig) {
      providersChecked.push(missingConfig);
      return null;
    }

    try {
      const listing = await action();
      providersChecked.push({
        providerId,
        status: listing ? "found" : "not_found",
        message: listing ? `${providerId} active listing found` : `${providerId} has no active listing for this mint`,
      });
      return listing;
    } catch (error) {
      providersChecked.push({
        providerId,
        status: "error",
        message: error instanceof Error ? error.message : "request failed",
      });
      return null;
    }
  };

  if (!providerEnabled("MAGIC_EDEN_ENABLED")) {
    providersChecked.push({ providerId: "magic-eden", status: "disabled", message: "Provider not connected." });
  }
  const magicEdenListing = providerEnabled("MAGIC_EDEN_ENABLED") ? await tryProvider("magic-eden", () => fetchMagicEdenListing(mint)) : null;
  if (magicEdenListing) {
    return {
      mint,
      found: true,
      listing: magicEdenListing,
      providersChecked,
      reason: "Magic Eden active listing found",
      verificationStatus: "verified_listed",
    };
  }

  if (runtime.TENSOR_API_KEY) {
    const tensorListing = await tryProvider(
      "tensor",
      () => fetchGenericListing("tensor", runtime.TENSOR_API_URL ?? "", mint, {
        apiKey: runtime.TENSOR_API_KEY,
        apiKeyHeader: "x-api-key",
        mintParam: "mint",
      }),
      runtime.TENSOR_API_URL ? null : { providerId: "tensor", status: "needs_endpoint", message: "TENSOR_API_URL is not configured" },
    );
    if (tensorListing) {
      return {
        mint,
        found: true,
        listing: tensorListing,
        providersChecked,
        reason: "Tensor active listing found",
        verificationStatus: "verified_listed",
      };
    }
  }

  if (providerEnabled("PHYGITALS_ENABLED") && runtime.PHYGITALS_API_URL) {
    const phygitalsListing = await tryProvider(
      "phygitals",
      () => fetchGenericListing("phygitals", runtime.PHYGITALS_API_URL ?? "", mint, {
        apiKey: runtime.PHYGITALS_API_KEY,
        apiKeyHeader: "Authorization",
        mintParam: "mint",
      }),
    );
    if (phygitalsListing) {
      return {
        mint,
        found: true,
        listing: phygitalsListing,
        providersChecked,
        reason: "Phygitals active listing found",
        verificationStatus: "verified_listed",
      };
    }
  } else {
    providersChecked.push({ providerId: "phygitals", status: "disabled", message: "Provider not connected." });
  }

  // Collector Crypt: check snapshot first, then fallback to API if configured
  if (providerEnabled("COLLECTOR_CRYPT_ENABLED")) {
    const snapshotListing = await tryProvider("collector-crypt", () => fetchCollectorCryptListingFromSnapshot(mint));
    if (snapshotListing) {
      return {
        mint,
        found: true,
        listing: snapshotListing,
        providersChecked,
        reason: "Collector Crypt active listing found (from snapshot)",
        verificationStatus: "verified_listed",
      };
    }

    // Fallback to API if configured and snapshot didn't have it
    if (runtime.COLLECTOR_CRYPT_API_URL) {
      const collectorCryptListing = await tryProvider(
        "collector-crypt",
        () => fetchGenericListing("collector-crypt", runtime.COLLECTOR_CRYPT_API_URL ?? "", mint, {
          apiKey: runtime.COLLECTOR_CRYPT_API_KEY,
          apiKeyHeader: "Authorization",
          mintParam: "mint",
        }),
      );
      if (collectorCryptListing) {
        return {
          mint,
          found: true,
          listing: collectorCryptListing,
          providersChecked,
          reason: "Collector Crypt active listing found (from API)",
          verificationStatus: "verified_listed",
        };
      }
    }
  } else {
    providersChecked.push({ providerId: "collector-crypt", status: "disabled", message: "Provider not connected." });
  }

  return {
    mint,
    found: false,
    listing: null,
    providersChecked,
    reason: providersChecked.length ? "No active listing found" : "No marketplace listing providers configured",
    verificationStatus: deriveVerificationStatus(false, providersChecked),
  };
}
