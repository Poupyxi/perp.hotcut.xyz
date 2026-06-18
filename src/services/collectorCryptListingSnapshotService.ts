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
}> {
  const apiUrl = process.env.COLLECTOR_CRYPT_API_URL;
  if (!apiUrl) {
    throw new Error("COLLECTOR_CRYPT_API_URL not configured");
  }

  const listingsPath = process.env.COLLECTOR_CRYPT_LISTINGS_PATH || "/listings";
  const url = new URL(listingsPath, apiUrl);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(limit));

  const response = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json() as unknown;
  if (!data || typeof data !== "object") {
    throw new Error("Invalid API response structure");
  }

  const obj = data as Record<string, unknown>;

  // Extract listings array
  let items: unknown[] = [];
  if (Array.isArray(obj.listings)) {
    items = obj.listings;
  } else if (Array.isArray(obj.data)) {
    items = obj.data;
  } else if (Array.isArray(obj.items)) {
    items = obj.items;
  }

  // Extract pagination info
  const total = typeof obj.total === "number" ? obj.total : 0;
  const totalPages = typeof obj.total_pages === "number" ? obj.total_pages : typeof obj.totalPages === "number" ? obj.totalPages : Math.ceil(total / limit);

  const listings = normalizeListings(items);
  const hasMore = page < totalPages;

  return {
    listings,
    total,
    totalPages,
    hasMore,
  };
}

function normalizeListings(items: unknown[]): CollectorCryptListing[] {
  const listings: CollectorCryptListing[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    const obj = item as Record<string, unknown>;

    // Extract required fields
    const listingId = String(obj.listing_id || obj.id || obj.listingId || "").trim();
    const mint = String(obj.mint || obj.assetMint || obj.nft_mint || "").trim();

    if (!listingId || !mint) continue;

    const listing: CollectorCryptListing = {
      provider: "collector-crypt",
      listingId,
      mint,
      marketplace: String(obj.marketplace || obj.market || "").trim() || undefined,
      price: typeof obj.price === "number" ? obj.price : typeof obj.price === "string" ? parseFloat(obj.price) : undefined,
      currency: String(obj.currency || obj.symbol || "").trim() || undefined,
      seller: String(obj.seller || obj.sellerWallet || obj.sellerAddress || "").trim() || undefined,
      listedAt: String(obj.listedAt || obj.listed_at || obj.createdAt || obj.created_at || "").trim() || undefined,
      updatedAt: String(obj.updatedAt || obj.updated_at || "").trim() || undefined,
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

        // Store listings in transaction
        const transaction = db.transaction((listings: CollectorCryptListing[], snapId: string) => {
          for (const listing of listings) {
            const listingId = `${snapId}:${listing.provider}:${listing.listingId}`;
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
              snapId,
              "active",
              1,
              listing.rawPayload ? stringifyJson(listing.rawPayload) : null,
              insertedAt,
            );
          }
        });

        transaction(pageData.listings, snapshotId);
        totalStored += pageData.listings.length;

        hasMore = pageData.hasMore;
        page++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "unknown error";
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

    // Only compare if status is complete
    let disappearedListingIds: string[] = [];
    if (status === "complete") {
      const previousSnapshot = getPreviousCompleteSnapshot(db);

      if (previousSnapshot) {
        const comparison = compareSnapshots({
          currentSnapshotId: snapshotId,
          previousSnapshotId: previousSnapshot.id,
        });

        disappearedListingIds = comparison.disappeared.map((d) => d.listingId);

        // Queue disappeared listings for verification in atomic transaction
        const queueTransaction = db.transaction((disappearedItems: typeof comparison.disappeared) => {
          for (const { provider, listingId, mint, previousListing } of disappearedItems) {
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
          if (previousSnapshot) {
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            db.prepare("UPDATE collector_crypt_snapshots SET status='archived' WHERE id=? AND created_at < ?").run(
              previousSnapshot.id,
              sevenDaysAgo,
            );
          }
        });

        queueTransaction(comparison.disappeared);
      }
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
