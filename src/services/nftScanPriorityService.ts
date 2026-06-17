// Adaptive scan priority logic for NFT assets.
// Priority order: listed > hot > warm > cold
// Within same priority, pokemon-cards category is processed first.

export type ScanPriority = "listed" | "hot" | "warm" | "cold";

export type ScanPriorityResult = {
  priority: ScanPriority;
  reason: string;
  /** ISO string — when this NFT should next be scanned */
  nextScanAt: string;
};

// Default scan intervals per priority (configurable via env).
export const SCAN_INTERVAL_DEFAULTS: Record<ScanPriority, number> = {
  listed: 120,    // 2 min
  hot: 600,       // 10 min
  warm: 3_600,    // 1 hour
  cold: 43_200,   // 12 hours
};

export type ScanIntervalConfig = {
  listedIntervalSeconds: number;
  hotIntervalSeconds: number;
  warmIntervalSeconds: number;
  coldIntervalSeconds: number;
};

export function getScanIntervalSeconds(priority: ScanPriority, config: ScanIntervalConfig): number {
  switch (priority) {
    case "listed": return config.listedIntervalSeconds;
    case "hot":    return config.hotIntervalSeconds;
    case "warm":   return config.warmIntervalSeconds;
    case "cold":   return config.coldIntervalSeconds;
  }
}

export function computeScanPriority(row: {
  is_listed?: number | null;
  listing_verification_status?: string | null;
  last_activity_at?: string | null;
}): { priority: ScanPriority; reason: string } {
  // listed priority ONLY for confirmed-listed NFTs — not for is_listed=0/unknown.
  // is_listed=1 alone is not sufficient; the marketplace must have confirmed the listing.
  const vs = row.listing_verification_status;
  if (vs === "verified_listed") {
    return { priority: "listed", reason: "listing_verification_status=verified_listed" };
  }

  const now = Date.now();
  const activityMs = row.last_activity_at ? new Date(row.last_activity_at).getTime() : null;

  if (activityMs && !Number.isNaN(activityMs)) {
    const ageMs = now - activityMs;
    if (ageMs < 24 * 3_600_000) {
      return { priority: "hot", reason: "activity_within_24h" };
    }
    if (ageMs < 7 * 24 * 3_600_000) {
      return { priority: "warm", reason: "activity_within_7d" };
    }
    return { priority: "cold", reason: "no_activity_7d_plus" };
  }

  return { priority: "cold", reason: "no_activity_recorded" };
}

export function computeNextScanAt(priority: ScanPriority, config: ScanIntervalConfig): string {
  const intervalMs = getScanIntervalSeconds(priority, config) * 1000;
  return new Date(Date.now() + intervalMs).toISOString();
}

/** Ordering weight for SQL-side priority sort (lower = higher priority). */
export function priorityWeight(priority: ScanPriority): number {
  switch (priority) {
    case "listed": return 0;
    case "hot":    return 1;
    case "warm":   return 2;
    case "cold":   return 3;
  }
}

/** Category ordering — pokemon first within same priority. */
export function categoryWeight(category: string | null | undefined): number {
  return category === "pokemon" ? 0 : 1;
}

/** Provider call strategy per priority. */
export type ScanStrategy = {
  /** Use listingOnly mode: 1 DAS call, skip tx history. */
  listingOnly: boolean;
  /** Force refresh even if within TTL. */
  forceRefresh: boolean;
  /** Max tx signatures to fetch (hot: 1, others: 0 via listingOnly). */
  signaturesLimit: number;
  /** Short description of what this scan will do. */
  description: string;
};

export function scanStrategyForPriority(priority: ScanPriority): ScanStrategy {
  switch (priority) {
    case "listed":
      // Only verify listing status — minimal provider usage.
      return { listingOnly: true, forceRefresh: true, signaturesLimit: 0, description: "listing-check (1 DAS)" };
    case "hot":
      // Full scan: DAS + 1 sig + 1 enhanced tx = 3 calls.
      return { listingOnly: false, forceRefresh: true, signaturesLimit: 1, description: "full-scan (DAS + activity)" };
    case "warm":
      // Metadata only — no transaction history unless cached is stale.
      return { listingOnly: true, forceRefresh: true, signaturesLimit: 0, description: "metadata-check (1 DAS)" };
    case "cold":
      // Minimal touch — skip if cache is still valid.
      return { listingOnly: true, forceRefresh: false, signaturesLimit: 0, description: "cold-check (cached/1 DAS)" };
  }
}
