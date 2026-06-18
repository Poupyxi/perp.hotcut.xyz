import { getNftDb, stringifyJson } from "./nftSqliteDb";
import { randomUUID } from "node:crypto";

export interface CollectorCryptListing {
  provider?: string;
  listingId: string;
  mint: string;
  marketplace?: string;
  price?: number;
  currency?: string;
  seller?: string;
  listedAt?: string;
  updatedAt?: string;
  rawPayload?: unknown;
}

export interface SnapshotComparisonResult {
  disappeared: Array<{
    provider: string;
    listingId: string;
    mint: string;
    previousListing: CollectorCryptListing;
  }>;
  newListings: CollectorCryptListing[];
  relistings: string[];
}

export interface SyncResult {
  snapshotId: string;
  status: "building" | "complete" | "partial" | "failed";
  listingsAnnounced: number;
  listingsStored: number;
  pagesFetched: number;
  disappearedCount: number;
  disappearedListingIds: string[];
  error?: string;
  validationErrors?: string[];
}

async function fetchCollectorCryptListingsPage(page: number, limit: number): Promise<{
  listings: CollectorCryptListing[];
  total: number;
  totalPages: number;
  hasMore: boolean;
  httpStatus?: number;
  rateLimitInfo?: { retryAfter?: string; remaining?: string };
}> {
  // Use official Collector Crypt API
  const baseUrl = "https://api.collectorcrypt.com";
  const endpoint = "/marketplace";

  const url = new URL(endpoint, baseUrl);
  url.searchParams.set("categories", "Pokemon");
  url.searchParams.set("marketplaceStatus", "Buy now");
  url.searchParams.set("marketplaceSource", "CC");
  url.searchParams.set("page", String(page));
  url.searchParams.set("step", String(limit));

  // Add randomized delay before fetching (3-5 seconds for better rate limit handling)
  const delayMs = 3000 + Math.random() * 2000;
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  const response = await fetch(url.toString(), {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 (compatible; CollectorCryptSync/1.0; +https://collectorcrypt.com)",
    },
    signal: AbortSignal.timeout(30_000),
  });

  // Extract rate limit headers for logging
  const rateLimitInfo = {
    retryAfter: response.headers.get("retry-after") || undefined,
    remaining: response.headers.get("x-ratelimit-remaining") || undefined,
  };

  if (!response.ok) {
    // Log error details
    const errorBody = await response.text();
    const sanitized = errorBody.substring(0, 200).replace(/[\n\r]/g, " ");
    console.error(`[CC API] Page ${page}: HTTP ${response.status}`);
    console.error(`[CC API] Rate limit info:`, rateLimitInfo);
    if (errorBody.includes("<!DOCTYPE")) {
      console.error(`[CC API] Error: HTML error page (likely rate limit)`);
    } else {
      console.error(`[CC API] Error body: ${sanitized}`);
    }

    // Return error status for caller to handle
    if (response.status === 403 || response.status === 429) {
      throw new Error(`HTTP ${response.status}: Rate limited or forbidden`);
    }
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json() as unknown;
  if (!data || typeof data !== "object") {
    throw new Error("Invalid API response structure");
  }

  const obj = data as Record<string, unknown>;

  // Official API response mapping:
  const items = Array.isArray(obj.filterNFtCard) ? obj.filterNFtCard : [];
  const total = typeof obj.findTotal === "number" ? obj.findTotal : 0;
  const totalPages = typeof obj.totalPages === "number" ? obj.totalPages : Math.ceil(total / limit);

  const listings = normalizeListings(items);
  const hasMore = page < totalPages;

  return {
    listings,
    total,
    totalPages,
    hasMore,
    httpStatus: response.status,
    rateLimitInfo,
  };
}

function normalizeListings(items: unknown[]): CollectorCryptListing[] {
  const listings: CollectorCryptListing[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    const obj = item as Record<string, unknown>;

    // Official Collector Crypt API mapping
    const mint = String(obj.nftAddress || "").trim();
    const listingObj = obj.listing as Record<string, unknown> || {};
    const ownerObj = obj.owner as Record<string, unknown> || {};

    // Seller identification (prefer wallet, fallback to ownerId)
    const seller = String(ownerObj.wallet || obj.ownerId || "").trim();

    if (!mint || !seller) continue;

    // ListingId: use receiptId if available
    // If missing, generate deterministic ID from mint + seller + createdAt + price + currency
    let listingId = String(listingObj.receiptId || "").trim();
    if (!listingId) {
      const createdAt = String(listingObj.createdAt || "").trim();
      const price = listingObj.price;
      const currency = String(listingObj.currency || "").trim();

      if (!createdAt || !price || !currency) {
        // Skip listings without enough data to generate stable ID
        continue;
      }

      // Generate deterministic ID from: mint + seller + createdAt + price + currency
      // Use a simple hash-like approach: take first 8 chars of each component
      const components = [
        mint.substring(0, 8),
        seller.substring(0, 8),
        createdAt.substring(0, 10), // Date part only (YYYY-MM-DD)
        String(price).substring(0, 6),
        currency.substring(0, 4),
      ].join("_");

      listingId = `cc_${components}`;
    }

    const listing: CollectorCryptListing = {
      provider: "collector-crypt",
      listingId,
      mint,
      marketplace: String(listingObj.marketplace || "").trim() || undefined,
      price: typeof listingObj.price === "number" ? listingObj.price : typeof listingObj.price === "string" ? parseFloat(listingObj.price as string) : undefined,
      currency: String(listingObj.currency || "").trim() || undefined,
      seller,
      listedAt: String(listingObj.createdAt || "").trim() || undefined,
      updatedAt: String(listingObj.updatedAt || "").trim() || undefined,
      rawPayload: obj,
    };

    listings.push(listing);
  }

  return listings;
}

function getPreviousCompleteSnapshot(db: any): { id: string; createdAt: string } | null {
  const row = db
    .prepare("SELECT id, created_at FROM collector_crypt_snapshots WHERE status='complete' ORDER BY created_at DESC LIMIT 1")
    .get() as { id: string; created_at: string } | undefined;
  return row || null;
}

function getPreviousListingsByIdentity(db: any, snapshotId: string): Map<string, CollectorCryptListing> {
  const rows = db
    .prepare(
      `SELECT provider, listing_id, mint, marketplace, listing_price, listing_currency, seller, listed_at, updated_at, raw_payload_json
       FROM collector_crypt_listings
       WHERE snapshot_id = ? AND is_current_snapshot = 1`,
    )
    .all(snapshotId) as Array<{
    provider: string;
    listing_id: string;
    mint: string;
    marketplace?: string;
    listing_price?: number;
    listing_currency?: string;
    seller?: string;
    listed_at?: string;
    updated_at?: string;
    raw_payload_json?: string;
  }>;

  const map = new Map<string, CollectorCryptListing>();
  for (const row of rows) {
    const key = `${row.provider}:${row.listing_id}`;
    map.set(key, {
      provider: row.provider,
      listingId: row.listing_id,
      mint: row.mint,
      marketplace: row.marketplace,
      price: row.listing_price,
      currency: row.listing_currency,
      seller: row.seller,
      listedAt: row.listed_at,
      updatedAt: row.updated_at,
      rawPayload: row.raw_payload_json ? JSON.parse(row.raw_payload_json) : undefined,
    });
  }

  return map;
}

export function compareSnapshots(input: {
  currentSnapshotId: string;
  previousSnapshotId: string | null;
}): SnapshotComparisonResult {
  const db = getNftDb();

  const currentListings = new Map<string, CollectorCryptListing>();
  const currentRows = db
    .prepare(
      `SELECT provider, listing_id, mint, marketplace, listing_price, listing_currency, seller, listed_at, updated_at, raw_payload_json
       FROM collector_crypt_listings
       WHERE snapshot_id = ? AND is_current_snapshot = 1`,
    )
    .all(input.currentSnapshotId) as Array<{
    provider: string;
    listing_id: string;
    mint: string;
    marketplace?: string;
    listing_price?: number;
    listing_currency?: string;
    seller?: string;
    listed_at?: string;
    updated_at?: string;
    raw_payload_json?: string;
  }>;

  for (const row of currentRows) {
    const key = `${row.provider}:${row.listing_id}`;
    currentListings.set(key, {
      provider: row.provider,
      listingId: row.listing_id,
      mint: row.mint,
      marketplace: row.marketplace,
      price: row.listing_price,
      currency: row.listing_currency,
      seller: row.seller,
      listedAt: row.listed_at,
      updatedAt: row.updated_at,
      rawPayload: row.raw_payload_json ? JSON.parse(row.raw_payload_json) : undefined,
    });
  }

  const previousListings = input.previousSnapshotId ? getPreviousListingsByIdentity(db, input.previousSnapshotId) : new Map();

  const disappeared: Array<{ provider: string; listingId: string; mint: string; previousListing: CollectorCryptListing }> = [];
  const relistings: string[] = [];

  // Check which previous listings have disappeared
  for (const [key, prevListing] of previousListings) {
    if (!currentListings.has(key)) {
      disappeared.push({
        provider: prevListing.provider || "collector-crypt",
        listingId: prevListing.listingId,
        mint: prevListing.mint,
        previousListing: prevListing,
      });
    } else {
      relistings.push(key);
    }
  }

  // New listings are those not in previous snapshot
  const newListings: CollectorCryptListing[] = [];
  for (const [key, currentListing] of currentListings) {
    if (!previousListings.has(key)) {
      newListings.push(currentListing);
    }
  }

  return {
    disappeared,
    newListings,
    relistings,
  };
}

export async function syncCollectorCryptSnapshot(): Promise<SyncResult> {
  const db = getNftDb();
  const snapshotId = randomUUID();
  const now = new Date().toISOString();
  const pageLimit = 100;
  const validationErrors: string[] = [];
  let status: "building" | "complete" | "partial" | "failed" = "building";
  let totalAnnounced = 0;
  let pagesFetched = 0;
  let totalStored = 0;

  try {
    // Create snapshot with building status
    db.prepare(
      `INSERT INTO collector_crypt_snapshots (id, snapshot_at, status, page_limit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(snapshotId, now, "building", pageLimit, now, now);

    // Fetch all pages with pagination
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const pageData = await fetchCollectorCryptListingsPage(page, pageLimit);
        totalAnnounced = pageData.total;
        pagesFetched = page;

        // Store listings
        for (const listing of pageData.listings) {
          const listingId = `${snapshotId}:${listing.provider}:${listing.listingId}`;
          const insertedAt = new Date().toISOString();

          db.prepare(
            `INSERT INTO collector_crypt_listings (
              id, provider, listing_id, mint, marketplace, listing_price, listing_currency, seller, listed_at, updated_at,
              snapshot_id, listing_status, is_current_snapshot, raw_payload_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            listingId,
            listing.provider || "collector-crypt",
            listing.listingId,
            listing.mint,
            listing.marketplace || null,
            listing.price || null,
            listing.currency || null,
            listing.seller || null,
            listing.listedAt || null,
            listing.updatedAt || null,
            snapshotId,
            "active",
            1,
            listing.rawPayload ? stringifyJson(listing.rawPayload) : null,
            insertedAt,
          );
        }
        totalStored += pageData.listings.length;

        hasMore = pageData.hasMore;
        page++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "unknown error";

        // On rate limiting (403/429), stop immediately and mark partial/failed
        if (errorMsg.includes("403") || errorMsg.includes("429") || errorMsg.includes("Rate limited")) {
          console.error(`[CC Sync] Rate limited on page ${page}. Stopping snapshot.`);
          validationErrors.push(`Page ${page}: Rate limited (${errorMsg})`);
          // Mark as partial if we have some data, failed if page 1
          status = page === 1 ? "failed" : "partial";
          break;
        }

        validationErrors.push(`Page ${page} failed: ${errorMsg}`);
        if (page === 1) {
          status = "failed";
          break;
        }
      }
    }

    // Validate snapshot completeness
    if (status !== "failed") {
      const storedCount = db
        .prepare("SELECT COUNT(*) as count FROM collector_crypt_listings WHERE snapshot_id = ?")
        .get(snapshotId) as { count: number };
      totalStored = storedCount.count;

      // Check if counts match
      if (totalAnnounced > 0 && Math.abs(storedCount.count - totalAnnounced) > Math.max(totalAnnounced * 0.02, 1)) {
        validationErrors.push(`Fetched ${totalStored} but API announced ${totalAnnounced}`);
        status = "partial";
      } else {
        status = "complete";
      }
    }

    // Update snapshot status
    db.prepare(
      `UPDATE collector_crypt_snapshots SET
        status = ?, pages_fetched = ?, total_listings_announced = ?, listings_stored = ?,
        validation_errors = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      status,
      pagesFetched,
      totalAnnounced,
      totalStored,
      validationErrors.length > 0 ? stringifyJson(validationErrors) : null,
      now,
      snapshotId,
    );

    // Only compare and queue if status is complete
    // Partial/failed snapshots do NOT trigger disappeared listing detection
    let disappearedListingIds: string[] = [];
    if (status === "complete") {
      const previousSnapshot = getPreviousCompleteSnapshot(db);

      if (previousSnapshot) {
        const comparison = compareSnapshots({
          currentSnapshotId: snapshotId,
          previousSnapshotId: previousSnapshot.id,
        });

        disappearedListingIds = comparison.disappeared.map((d) => d.listingId);

        // Queue disappeared listings for verification
        for (const { provider, listingId, mint, previousListing } of comparison.disappeared) {
          const queueId = `${provider}:${listingId}:${snapshotId}`;
          const queueNow = new Date().toISOString();

          // Check if already queued (avoid duplicates)
          const existing = db
            .prepare("SELECT id FROM collector_crypt_verification_queue WHERE provider=? AND listing_id=? AND status IN ('pending','in_progress')")
            .get(provider, listingId);

          if (!existing) {
            db.prepare(
              `INSERT INTO collector_crypt_verification_queue (
                id, provider, listing_id, mint, reason, previous_listing_price, previous_listing_at, previous_owner,
                status, attempt_count, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              queueId,
              provider,
              listingId,
              mint,
              "disappeared_from_listing",
              previousListing.price || null,
              previousListing.listedAt || null,
              previousListing.seller || null,
              "pending",
              0,
              queueNow,
              queueNow,
            );
          }
        }

        // Archive previous complete snapshot if new one is valid
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        db.prepare("UPDATE collector_crypt_snapshots SET status='archived' WHERE id=? AND created_at < ?").run(
          previousSnapshot.id,
          sevenDaysAgo,
        );
      }
    } else {
      // Partial/failed snapshots: keep previous complete snapshot active
      // Don't archive anything, don't queue disappeared listings
      console.log(`[CC Sync] Snapshot ${snapshotId} status: ${status}. Keeping previous complete snapshot active.`);
    }

    return {
      snapshotId,
      status,
      listingsAnnounced: totalAnnounced,
      listingsStored: totalStored,
      pagesFetched,
      disappearedCount: disappearedListingIds.length,
      disappearedListingIds,
      validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "unknown error";

    // Mark snapshot as failed
    db.prepare(
      `UPDATE collector_crypt_snapshots SET status='failed', error_message=?, updated_at=? WHERE id=?`,
    ).run(errorMsg, now, snapshotId);

    return {
      snapshotId,
      status: "failed",
      listingsAnnounced: totalAnnounced,
      listingsStored: totalStored,
      pagesFetched,
      disappearedCount: 0,
      disappearedListingIds: [],
      error: errorMsg,
    };
  }
}
