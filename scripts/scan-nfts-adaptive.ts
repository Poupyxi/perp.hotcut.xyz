// Adaptive NFT scan scheduler — priority-based scanning with intelligent intervals.
//
// Priority order (processed first to last):
//   1. listed pokemon-cards
//   2. listed other categories
//   3. hot pokemon-cards
//   4. hot other categories
//   5. warm pokemon-cards
//   6. warm other categories
//   7. cold pokemon-cards
//   8. cold other categories
//
// Usage:
//   docker exec perp-frontend sh -c "cd /app && npx tsx scripts/scan-nfts-adaptive.ts \
//     --concurrency=8 \
//     --limit=0 \
//     --category= \
//     --reportEverySeconds=10 \
//     --dryRun=false"
//
// Intervals (configurable via env):
//   SCAN_LISTED_INTERVAL_SECONDS=120    (2 min)
//   SCAN_HOT_INTERVAL_SECONDS=600       (10 min)
//   SCAN_WARM_INTERVAL_SECONDS=3600     (1 hour)
//   SCAN_COLD_INTERVAL_SECONDS=43200    (12 hours)

import { getNftDb } from "../src/services/nftSqliteDb";
import { refreshNftByMint } from "../src/services/nftListEnrichmentService";
import { getHeliusKeyStats } from "../src/services/heliusApiKeyRotation";
import { readNftScannerConfig } from "../src/services/nftScannerConfig";
import {
  computeScanPriority,
  computeNextScanAt,
  scanStrategyForPriority,
  type ScanPriority,
  type ScanIntervalConfig,
} from "../src/services/nftScanPriorityService";

// ── CLI arg helpers ────────────────────────────────────────────────────────────

function arg(name: string, fallback?: string) {
  const prefix = `--${name}=`;
  const m = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return m ? m.slice(prefix.length) : fallback;
}
function numArg(name: string, fallback: number) {
  const v = Number(arg(name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}
function boolArg(name: string, fallback: boolean) {
  const v = arg(name);
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

function fmtNum(n: number) { return n.toLocaleString("en-US"); }
function fmtPct(n: number, total: number) {
  if (total === 0) return "0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}
function fmtDuration(ms: number): string {
  if (ms < 0) return "?";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

// ── Priority-aware row type ────────────────────────────────────────────────────

type NftRow = {
  mint: string;
  category: string | null;
  is_listed: number | null;
  last_activity_at: string | null;
  last_scanned_at: string | null;
  next_scan_at: string | null;
  scan_priority: string | null;
};

// ── Metrics ────────────────────────────────────────────────────────────────────

type ScanMetrics = {
  // Counts by priority at query time
  listedCount: number;
  hotCount: number;
  warmCount: number;
  coldCount: number;
  // Per-run stats
  nftsScanned: number;
  nftsSkipped: number;
  shyftCalls: number;
  heliusCalls: number;
  solscanCalls: number;
  listingChangesDetected: number;
  ownerChangesDetected: number;
  errors: number;
};

// ── Write priority state to DB ─────────────────────────────────────────────────

function writeScanState(
  db: ReturnType<typeof getNftDb>,
  mint: string,
  priority: ScanPriority,
  priorityReason: string,
  nextScanAt: string,
  listingChecked: boolean,
): void {
  const now = new Date().toISOString();
  const listingCheckedAt = listingChecked ? now : undefined;

  if (listingCheckedAt !== undefined) {
    db.prepare(`
      UPDATE nft_assets
      SET scan_priority = ?, priority_reason = ?, last_scanned_at = ?, next_scan_at = ?,
          last_listing_checked_at = ?, updated_at = ?
      WHERE mint = ?
    `).run(priority, priorityReason, now, nextScanAt, listingCheckedAt, now, mint);
  } else {
    db.prepare(`
      UPDATE nft_assets
      SET scan_priority = ?, priority_reason = ?, last_scanned_at = ?, next_scan_at = ?, updated_at = ?
      WHERE mint = ?
    `).run(priority, priorityReason, now, nextScanAt, now, mint);
  }
}

// ── Priority distribution for a query result ──────────────────────────────────

function countByPriority(rows: NftRow[]): Record<ScanPriority, number> {
  const counts: Record<ScanPriority, number> = { listed: 0, hot: 0, warm: 0, cold: 0 };
  for (const row of rows) {
    const { priority } = computeScanPriority(row);
    counts[priority]++;
  }
  return counts;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const concurrency = Math.max(1, Math.min(64, numArg("concurrency", 8)));
  const limit = Math.max(0, numArg("limit", 0));
  const category = arg("category", "");
  const dryRun = boolArg("dryRun", false);
  const reportEverySeconds = Math.max(2, numArg("reportEverySeconds", 10));

  const config = readNftScannerConfig({ dryRun });
  const intervalConfig: ScanIntervalConfig = {
    listedIntervalSeconds: config.scanListedIntervalSeconds,
    hotIntervalSeconds: config.scanHotIntervalSeconds,
    warmIntervalSeconds: config.scanWarmIntervalSeconds,
    coldIntervalSeconds: config.scanColdIntervalSeconds,
  };

  console.log("[ADAPTIVE SCAN] Starting adaptive NFT scan scheduler");
  console.log(`[ADAPTIVE SCAN] concurrency=${concurrency} limit=${limit || "all"} category=${category || "all"} dryRun=${dryRun}`);
  console.log(`[ADAPTIVE SCAN] Intervals: listed=${intervalConfig.listedIntervalSeconds}s hot=${intervalConfig.hotIntervalSeconds}s warm=${intervalConfig.warmIntervalSeconds}s cold=${intervalConfig.coldIntervalSeconds}s`);

  const db = getNftDb();

  // Build WHERE clause
  const where: string[] = ["(next_scan_at IS NULL OR next_scan_at <= datetime('now'))"];
  const params: unknown[] = [];
  if (category) {
    where.push("category = ?");
    params.push(category);
  }

  // Priority-aware ordering:
  // CASE priority weight from actual column values / derived columns
  // Pokémon always first within same priority tier.
  let sql = `
    SELECT
      mint, category, is_listed, last_activity_at,
      last_scanned_at, next_scan_at, scan_priority
    FROM nft_assets
    WHERE ${where.join(" AND ")}
    ORDER BY
      CASE
        WHEN is_listed = 1 THEN 0
        WHEN last_activity_at >= datetime('now', '-1 day') THEN 1
        WHEN last_activity_at >= datetime('now', '-7 days') THEN 2
        ELSE 3
      END ASC,
      CASE WHEN category = 'pokemon' THEN 0 ELSE 1 END ASC,
      COALESCE(next_scan_at, '1970-01-01') ASC
  `;
  if (limit > 0) {
    sql += ` LIMIT ?`;
    params.push(limit);
  }

  const rows = db.prepare(sql).all(...params) as NftRow[];
  const total = rows.length;

  if (total === 0) {
    console.log("[ADAPTIVE SCAN] No NFTs due for scan. All caught up.");
    return;
  }

  const priorityCounts = countByPriority(rows);
  console.log(`[ADAPTIVE SCAN] Due for scan: ${fmtNum(total)} NFTs`);
  console.log(`[ADAPTIVE SCAN] Priority breakdown: listed=${fmtNum(priorityCounts.listed)} hot=${fmtNum(priorityCounts.hot)} warm=${fmtNum(priorityCounts.warm)} cold=${fmtNum(priorityCounts.cold)}`);

  // ── Shared state ─────────────────────────────────────────────────────────────

  const metrics: ScanMetrics = {
    listedCount: priorityCounts.listed,
    hotCount: priorityCounts.hot,
    warmCount: priorityCounts.warm,
    coldCount: priorityCounts.cold,
    nftsScanned: 0,
    nftsSkipped: 0,
    shyftCalls: 0,
    heliusCalls: 0,
    solscanCalls: 0,
    listingChangesDetected: 0,
    ownerChangesDetected: 0,
    errors: 0,
  };

  let cursor = 0;
  const startedAt = Date.now();
  let lastReportAt = startedAt;
  let lastReportScanned = 0;

  // ── Worker ───────────────────────────────────────────────────────────────────

  async function worker(workerId: number) {
    while (true) {
      const idx = cursor++;
      if (idx >= total) return;

      const row = rows[idx];
      const { mint, category: rowCategory } = row;
      const { priority, reason } = computeScanPriority(row);
      const strategy = scanStrategyForPriority(priority);

      // Snapshot existing owner + listing state for change detection
      const existingRow = db.prepare(
        "SELECT owner, is_listed, listed_price_sol FROM nft_assets WHERE mint = ?"
      ).get(mint) as { owner: string | null; is_listed: number; listed_price_sol: number | null } | undefined;

      try {
        const result = await refreshNftByMint({
          mint,
          refresh: strategy.forceRefresh,
          dryRun,
          listingOnly: strategy.listingOnly,
        });

        if (result.cacheHit) {
          metrics.nftsSkipped++;
        } else {
          metrics.nftsScanned++;

          // Count provider calls by providerUsed
          const provider = result.providerUsed?.toLowerCase() ?? "";
          if (provider.includes("shyft")) metrics.shyftCalls++;
          else if (provider.includes("helius")) metrics.heliusCalls++;
          else if (provider.includes("solscan")) metrics.solscanCalls++;
          else if (result.heliusCalled) metrics.heliusCalls++;

          // Detect listing changes
          const nft = result.nft;
          if (nft && existingRow) {
            const wasListed = Boolean(existingRow.is_listed);
            const nowListed = Boolean(nft.isListed);
            if (wasListed !== nowListed) {
              metrics.listingChangesDetected++;

              // If listing disappeared, promote to hot so activity is analyzed soon
              if (wasListed && !nowListed && !dryRun) {
                const hotNext = computeNextScanAt("hot", intervalConfig);
                writeScanState(db, mint, "hot", "listing_disappeared", hotNext, true);
                console.log(`[ADAPTIVE SCAN] worker#${workerId} mint=${mint} listing DISAPPEARED → promoted to hot`);
                continue;
              }
            }

            // Detect owner changes
            if (existingRow.owner && nft.owner && existingRow.owner !== nft.owner) {
              metrics.ownerChangesDetected++;
            }
          }

          if (result.error) {
            metrics.errors++;
            if (metrics.errors <= 20) {
              console.error(`[ADAPTIVE SCAN] worker#${workerId} mint=${mint} error: ${result.error}`);
            }
          }
        }

        // Recompute priority from fresh data (listing may have changed)
        const freshRow = db.prepare(
          "SELECT is_listed, last_activity_at FROM nft_assets WHERE mint = ?"
        ).get(mint) as { is_listed: number | null; last_activity_at: string | null } | undefined;

        const { priority: freshPriority, reason: freshReason } = freshRow
          ? computeScanPriority(freshRow)
          : { priority, reason };

        const nextScanAt = computeNextScanAt(freshPriority, intervalConfig);
        const isListingRelated = freshPriority === "listed" || priority === "listed";

        if (!dryRun) {
          writeScanState(db, mint, freshPriority, freshReason, nextScanAt, isListingRelated);
        }
      } catch (err) {
        metrics.errors++;
        if (metrics.errors <= 20) {
          console.error(`[ADAPTIVE SCAN] worker#${workerId} mint=${mint} fatal:`, err instanceof Error ? err.message : err);
        }
        // Still update next_scan_at to avoid hammering a broken mint
        if (!dryRun) {
          const nextScanAt = computeNextScanAt(priority, intervalConfig);
          writeScanState(db, mint, priority, `error:${reason}`, nextScanAt, false);
        }
      }
    }
  }

  // ── Reporter ─────────────────────────────────────────────────────────────────

  const reporter = setInterval(() => {
    const now = Date.now();
    const elapsed = (now - startedAt) / 1000;
    const elapsedSinceReport = (now - lastReportAt) / 1000;
    const deltaScanned = metrics.nftsScanned + metrics.nftsSkipped - lastReportScanned;
    const ratePerSec = elapsedSinceReport > 0 ? deltaScanned / elapsedSinceReport : 0;
    const done = metrics.nftsScanned + metrics.nftsSkipped;
    const avgRate = elapsed > 0 ? done / elapsed : 0;
    const remaining = total - done;
    const etaMs = avgRate > 0 ? (remaining / avgRate) * 1000 : Infinity;
    const heliusStats = getHeliusKeyStats();
    const activeKeys = heliusStats.keys.filter((k) => !k.cooldownUntil).length;

    console.log(
      `[ADAPTIVE SCAN] ${fmtNum(done)}/${fmtNum(total)} (${fmtPct(done, total)}) ` +
      `rate=${ratePerSec.toFixed(1)}/s avg=${avgRate.toFixed(1)}/s ETA=${fmtDuration(etaMs)} ` +
      `[scanned=${fmtNum(metrics.nftsScanned)} skipped=${fmtNum(metrics.nftsSkipped)} errors=${fmtNum(metrics.errors)}] ` +
      `[shyft=${fmtNum(metrics.shyftCalls)} helius=${fmtNum(metrics.heliusCalls)} solscan=${fmtNum(metrics.solscanCalls)}] ` +
      `[listingΔ=${metrics.listingChangesDetected} ownerΔ=${metrics.ownerChangesDetected}] ` +
      `keys=${activeKeys}/${heliusStats.keyCount}`
    );

    lastReportAt = now;
    lastReportScanned = done;
  }, reportEverySeconds * 1000);

  // ── Run workers ───────────────────────────────────────────────────────────────

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);
  clearInterval(reporter);

  // ── Final report ──────────────────────────────────────────────────────────────

  const elapsed = (Date.now() - startedAt) / 1000;
  const finalHelius = getHeliusKeyStats();

  console.log(`\n[ADAPTIVE SCAN] DONE in ${fmtDuration(elapsed * 1000)}`);
  console.log(`\n  Priority snapshot at start:`);
  console.log(`    listed:  ${fmtNum(metrics.listedCount)}`);
  console.log(`    hot:     ${fmtNum(metrics.hotCount)}`);
  console.log(`    warm:    ${fmtNum(metrics.warmCount)}`);
  console.log(`    cold:    ${fmtNum(metrics.coldCount)}`);
  console.log(`\n  Scan results:`);
  console.log(`    NFTs scanned:             ${fmtNum(metrics.nftsScanned)}`);
  console.log(`    NFTs skipped (cache):     ${fmtNum(metrics.nftsSkipped)}`);
  console.log(`    Errors:                   ${fmtNum(metrics.errors)}`);
  console.log(`\n  Provider calls:`);
  console.log(`    Shyft calls:              ${fmtNum(metrics.shyftCalls)}`);
  console.log(`    Helius calls:             ${fmtNum(metrics.heliusCalls)}`);
  console.log(`    Solscan calls:            ${fmtNum(metrics.solscanCalls)}`);
  console.log(`\n  Changes detected:`);
  console.log(`    Listing changes:          ${fmtNum(metrics.listingChangesDetected)}`);
  console.log(`    Owner changes:            ${fmtNum(metrics.ownerChangesDetected)}`);
  console.log(`\n  Avg rate: ${(metrics.nftsScanned / elapsed).toFixed(1)} scans/s`);
  console.log(`  Helius keys used:`);
  for (const k of finalHelius.keys) {
    console.log(`    #${k.index} ${k.keyPrefix}...  calls=${fmtNum(k.calls)} 429=${k.errors429} auth=${k.errors4xxAuth} other=${k.errorsOther}`);
  }
}

main().catch((err) => {
  console.error("[ADAPTIVE SCAN] fatal", err);
  process.exit(1);
});
