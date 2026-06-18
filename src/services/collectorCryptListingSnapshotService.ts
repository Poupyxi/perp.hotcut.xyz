import { DatabaseSync } from "node:sqlite";
import { getNftDb, stringifyJson } from "./nftSqliteDb";
import { v4 as uuidv4 } from "crypto";

export interface CollectorCryptListing {
  mint: string;
  listingId?: string;
  marketplace?: string;
  price?: number;
  currency?: string;
  seller?: string;
  listedAt?: string;
  rawPayload?: unknown;
}

export interface SnapshotComparisonResult {
  disappeared: Array<{
    mint: string;
    previousListing: CollectorCryptListing;
  }>;
  newListings: CollectorCryptListing[];
  stillListed: string[];
}

export interface SyncResult {
  snapshotId: string;
  listingsFound: number;
  listingsStored: number;
  disappearedCount: number;
  disappearedMints: string[];
  error?: string;
}

async function fetchCollectorCryptListings(): Promise<CollectorCryptListing[]> {
  const apiUrl = process.env.COLLECTOR_CRYPT_API_URL;
  if (!apiUrl) {
    throw new Error("COLLECTOR_CRYPT_API_URL not configured");
  }

  const listingsPath = process.env.COLLECTOR_CRYPT_LISTINGS_PATH || "/listings";
  const url = new URL(listingsPath, apiUrl);

  try {
    const response = await fetch(url.toString(), {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    return normalizeCollectorCryptPayload(data);
  } catch (error) {
    throw new Error(`Failed to fetch Collector Crypt listings: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function normalizeCollectorCryptPayload(payload: unknown): CollectorCryptListing[] {
  if (!payload || typeof payload !== "object") return [];

  const listings: CollectorCryptListing[] = [];

  // Handle both array and object with 'listings' property
  const items = Array.isArray(payload) ? payload : (payload as Record<string, unknown>).listings;
  if (!Array.isArray(items)) return [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    const obj = item as Record<string, unknown>;
    const listing: CollectorCryptListing = {
      mint: String(obj.mint || obj.assetMint || obj.nft_mint || ""),
    };

    if (!listing.mint) continue;

    listing.listingId = String(obj.listingId || obj.id || "");
    listing.marketplace = String(obj.marketplace || obj.market || "");
    listing.price = typeof obj.price === "number" ? obj.price : typeof obj.price === "string" ? parseFloat(obj.price) : undefined;
    listing.currency = String(obj.currency || obj.symbol || "");
    listing.seller = String(obj.seller || obj.sellerWallet || obj.sellerAddress || "");
    listing.listedAt = String(obj.listedAt || obj.createdAt || obj.timestamp || "");
    listing.rawPayload = obj;

    listings.push(listing);
  }

  return listings;
}

function getLatestSnapshots(db: DatabaseSync): { current: string | null; previous: string | null } {
  const rows = db
    .prepare("SELECT id FROM collector_crypt_snapshots ORDER BY snapshot_at DESC LIMIT 2")
    .all() as Array<{ id: string }>;

  return {
    current: rows[0]?.id || null,
    previous: rows[1]?.id || null,
  };
}

function getPreviousListings(db: DatabaseSync, snapshotId: string | null): Map<string, CollectorCryptListing> {
  if (!snapshotId) return new Map();

  const rows = db
    .prepare(
      `SELECT mint, listing_id, marketplace, listing_price, listing_currency, seller, listed_at, raw_payload_json
       FROM collector_crypt_listings
       WHERE snapshot_id = ? AND is_current_snapshot = 1`,
    )
    .all(snapshotId) as Array<{
    mint: string;
    listing_id?: string;
    marketplace?: string;
    listing_price?: number;
    listing_currency?: string;
    seller?: string;
    listed_at?: string;
    raw_payload_json?: string;
  }>;

  const map = new Map<string, CollectorCryptListing>();
  for (const row of rows) {
    map.set(row.mint, {
      mint: row.mint,
      listingId: row.listing_id,
      marketplace: row.marketplace,
      price: row.listing_price,
      currency: row.listing_currency,
      seller: row.seller,
      listedAt: row.listed_at,
      rawPayload: row.raw_payload_json ? JSON.parse(row.raw_payload_json) : undefined,
    });
  }

  return map;
}

function archiveOldSnapshot(db: DatabaseSync, snapshotId: string): void {
  db.prepare("UPDATE collector_crypt_listings SET is_current_snapshot = 0 WHERE snapshot_id = ?").run(snapshotId);
}

function storeListing(
  db: DatabaseSync,
  mint: string,
  listing: CollectorCryptListing,
  snapshotId: string,
): void {
  const id = `cc-${snapshotId}-${mint}`;
  const now = new Date().toISOString();

  const existing = db
    .prepare("SELECT id FROM collector_crypt_listings WHERE mint = ? AND snapshot_id = ?")
    .get(mint, snapshotId);

  if (existing) {
    // Already in this snapshot, just update if needed
    return;
  }

  db.prepare(
    `INSERT INTO collector_crypt_listings (
      id, mint, marketplace, listing_id, listing_price, listing_currency, seller, listed_at,
      snapshot_id, listing_status, is_current_snapshot, raw_payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    mint,
    listing.marketplace || null,
    listing.listingId || null,
    listing.price || null,
    listing.currency || null,
    listing.seller || null,
    listing.listedAt || null,
    snapshotId,
    "active",
    1,
    listing.rawPayload ? stringifyJson(listing.rawPayload) : null,
    now,
    now,
  );
}

export function compareSnapshots(input: {
  currentSnapshotId: string;
  previousSnapshotId: string | null;
}): SnapshotComparisonResult {
  const db = getNftDb();

  const currentListings = new Map<string, CollectorCryptListing>();
  const currentRows = db
    .prepare(
      `SELECT mint, listing_id, marketplace, listing_price, listing_currency, seller, listed_at, raw_payload_json
       FROM collector_crypt_listings
       WHERE snapshot_id = ? AND is_current_snapshot = 1`,
    )
    .all(input.currentSnapshotId) as Array<{
    mint: string;
    listing_id?: string;
    marketplace?: string;
    listing_price?: number;
    listing_currency?: string;
    seller?: string;
    listed_at?: string;
    raw_payload_json?: string;
  }>;

  for (const row of currentRows) {
    currentListings.set(row.mint, {
      mint: row.mint,
      listingId: row.listing_id,
      marketplace: row.marketplace,
      price: row.listing_price,
      currency: row.listing_currency,
      seller: row.seller,
      listedAt: row.listed_at,
      rawPayload: row.raw_payload_json ? JSON.parse(row.raw_payload_json) : undefined,
    });
  }

  const previousListings = getPreviousListings(db, input.previousSnapshotId);

  const disappeared: Array<{ mint: string; previousListing: CollectorCryptListing }> = [];
  const stillListed: string[] = [];

  // Check which previous listings have disappeared
  for (const [mint, prevListing] of previousListings) {
    if (!currentListings.has(mint)) {
      disappeared.push({ mint, previousListing: prevListing });
    } else {
      stillListed.push(mint);
    }
  }

  // New listings are those not in previous snapshot
  const newListings: CollectorCryptListing[] = [];
  for (const [mint, currentListing] of currentListings) {
    if (!previousListings.has(mint)) {
      newListings.push(currentListing);
    }
  }

  // Archive old snapshot
  if (input.previousSnapshotId) {
    archiveOldSnapshot(db, input.previousSnapshotId);
  }

  return {
    disappeared,
    newListings,
    stillListed,
  };
}

export async function syncCollectorCryptSnapshot(): Promise<SyncResult> {
  const db = getNftDb();
  const snapshotId = uuidv4();
  const now = new Date().toISOString();

  try {
    // Fetch current listings from API
    const listings = await fetchCollectorCryptListings();

    // Create snapshot record
    db.prepare(
      `INSERT INTO collector_crypt_snapshots (id, snapshot_at, total_listings_found, listings_stored, is_complete, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(snapshotId, now, listings.length, 0, 1, now);

    // Store listings in transaction
    const transaction = db.transaction((listingsToStore: CollectorCryptListing[]) => {
      for (const listing of listingsToStore) {
        storeListing(db, listing.mint, listing, snapshotId);
      }
    });

    transaction(listings);

    // Update snapshot with stored count
    const storedCount = db
      .prepare("SELECT COUNT(*) as count FROM collector_crypt_listings WHERE snapshot_id = ?")
      .get(snapshotId) as { count: number };
    db.prepare("UPDATE collector_crypt_snapshots SET listings_stored = ? WHERE id = ?").run(storedCount.count, snapshotId);

    // Compare with previous snapshot to detect disappeared listings
    const { current, previous } = getLatestSnapshots(db);
    const disappearedMints: string[] = [];

    if (previous && current === snapshotId) {
      const comparison = compareSnapshots({
        currentSnapshotId: current,
        previousSnapshotId: previous,
      });

      disappearedMints.push(...comparison.disappeared.map((d) => d.mint));

      // Queue disappeared listings for verification
      const queueTransaction = db.transaction((disappeared: Array<{ mint: string; previousListing: CollectorCryptListing }>) => {
        for (const { mint, previousListing } of disappeared) {
          const queueId = `cc-verify-${mint}-${snapshotId}`;
          const queueNow = new Date().toISOString();

          db.prepare(
            `INSERT OR IGNORE INTO collector_crypt_verification_queue (
              id, mint, reason, previous_listing_price, previous_listing_at, previous_owner,
              status, attempt_count, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            queueId,
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
      });

      queueTransaction(comparison.disappeared);
    }

    return {
      snapshotId,
      listingsFound: listings.length,
      listingsStored: storedCount.count,
      disappearedCount: disappearedMints.length,
      disappearedMints,
    };
  } catch (error) {
    // Mark snapshot as incomplete
    db.prepare("UPDATE collector_crypt_snapshots SET is_complete = 0, error_message = ? WHERE id = ?").run(
      error instanceof Error ? error.message : "unknown error",
      snapshotId,
    );

    throw error;
  }
}
