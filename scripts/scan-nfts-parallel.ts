// Parallel full-DB Helius enrichment of NFT assets.
// Calls `refreshNftByMint({ refresh: true })` per mint via the Helius rotation
// — this is the function that actually hits Helius DAS for metadata + activity.
//
// Usage:
//   docker exec perp-frontend sh -c "cd /app && npx tsx scripts/scan-nfts-parallel.ts \
//     --concurrency=12 \
//     --limit=0 \                # 0 = all
//     --onlyStale=false \
//     --staleSeconds=86400 \
//     --reportEverySeconds=5"

import { getNftDb } from "../src/services/nftSqliteDb";
import { refreshNftByMint } from "../src/services/nftListEnrichmentService";
import { getHeliusKeyStats } from "../src/services/heliusApiKeyRotation";

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
function fmtNum(n: number) {
  return n.toLocaleString("en-US");
}
function fmtPct(n: number, total: number) {
  if (total === 0) return "0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

async function main() {
  const concurrency = Math.max(1, Math.min(64, numArg("concurrency", 12)));
  const limit = Math.max(0, numArg("limit", 0));
  const onlyStale = boolArg("onlyStale", true);
  const staleSeconds = numArg("staleSeconds", 86400);
  const refresh = boolArg("refresh", true);
  const listingOnly = boolArg("listingOnly", false);
  const category = arg("category", "");          // e.g. --category=pokemon
  const reportEverySeconds = Math.max(2, numArg("reportEverySeconds", 5));

  const db = getNftDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (category) {
    where.push("category = ?");
    params.push(category);
  }
  if (onlyStale) {
    where.push("(last_checked_at IS NULL OR last_checked_at < datetime('now', ?))");
    params.push(`-${staleSeconds} seconds`);
  }

  let sql = `SELECT mint FROM nft_assets`;
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += ` ORDER BY last_checked_at IS NULL DESC, last_checked_at ASC`;
  if (limit > 0) {
    sql += ` LIMIT ?`;
    params.push(limit);
  }

  const rows = db.prepare(sql).all(...params) as Array<{ mint: string }>;
  const mints = rows.map((r) => r.mint);
  const total = mints.length;

  console.log(`[PARALLEL SCAN] target=${fmtNum(total)} mints, category=${category || "all"}, concurrency=${concurrency}, refresh=${refresh}, listingOnly=${listingOnly}, onlyStale=${onlyStale}, staleSeconds=${staleSeconds}`);

  let cursor = 0;
  let processed = 0;
  let heliusCalled = 0;
  let updated = 0;
  let cacheHits = 0;
  let errors = 0;
  const startedAt = Date.now();
  let lastReportAt = startedAt;
  let lastReportProcessed = 0;
  let lastReportHelius = 0;

  async function worker(workerId: number) {
    while (true) {
      const idx = cursor++;
      if (idx >= total) return;
      const mint = mints[idx];
      try {
        const result = await refreshNftByMint({ mint, refresh, listingOnly });
        if (result.heliusCalled) heliusCalled += 1;
        if (result.dbUpdated) updated += 1;
        if (result.cacheHit) cacheHits += 1;
        if (result.error) errors += 1;
      } catch (err) {
        errors += 1;
        if (errors < 20) {
          console.error(`[PARALLEL SCAN] worker#${workerId} mint=${mint} fatal:`, err instanceof Error ? err.message : err);
        }
      }
      processed += 1;
    }
  }

  const reporter = setInterval(() => {
    const now = Date.now();
    const elapsedTotal = (now - startedAt) / 1000;
    const elapsedSinceReport = (now - lastReportAt) / 1000;
    const deltaProcessed = processed - lastReportProcessed;
    const deltaHelius = heliusCalled - lastReportHelius;
    const ratePerSec = elapsedSinceReport > 0 ? deltaProcessed / elapsedSinceReport : 0;
    const heliusRatePerSec = elapsedSinceReport > 0 ? deltaHelius / elapsedSinceReport : 0;
    const avgRatePerSec = elapsedTotal > 0 ? processed / elapsedTotal : 0;
    const remaining = total - processed;
    const etaSec = avgRatePerSec > 0 ? remaining / avgRatePerSec : Infinity;
    const heliusStats = getHeliusKeyStats();
    const activeKeys = heliusStats.keys.filter((k) => !k.cooldownUntil).length;
    console.log(
      `[PARALLEL SCAN] ${fmtNum(processed)}/${fmtNum(total)} (${fmtPct(processed, total)}) ` +
      `rate=${ratePerSec.toFixed(1)}/s avg=${avgRatePerSec.toFixed(1)}/s helius=${heliusRatePerSec.toFixed(1)}/s ` +
      `ETA=${etaSec === Infinity ? "?" : Math.round(etaSec) + "s"} ` +
      `[heliusCalled=${fmtNum(heliusCalled)} updated=${fmtNum(updated)} cacheHits=${fmtNum(cacheHits)} errors=${fmtNum(errors)}] ` +
      `keys=${activeKeys}/${heliusStats.keyCount}`,
    );
    for (const k of heliusStats.keys) {
      const note = k.cooldownUntil ? ` [${k.cooldownReason} until ${k.cooldownUntil.slice(11, 19)}]` : "";
      console.log(`  key #${k.index} (${k.keyPrefix}...) calls=${fmtNum(k.calls)} 429=${k.errors429} auth=${k.errors4xxAuth} other=${k.errorsOther}${note}`);
    }
    lastReportAt = now;
    lastReportProcessed = processed;
    lastReportHelius = heliusCalled;
  }, reportEverySeconds * 1000);

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);
  clearInterval(reporter);

  const elapsed = (Date.now() - startedAt) / 1000;
  const finalStats = getHeliusKeyStats();
  console.log(`\n[PARALLEL SCAN] DONE in ${elapsed.toFixed(0)}s`);
  console.log(`  Mints processed:  ${fmtNum(processed)}`);
  console.log(`  Helius called:    ${fmtNum(heliusCalled)}`);
  console.log(`  DB updated:       ${fmtNum(updated)}`);
  console.log(`  Cache hits:       ${fmtNum(cacheHits)}`);
  console.log(`  Errors:           ${fmtNum(errors)}`);
  console.log(`  Avg rate:         ${(processed / elapsed).toFixed(1)} mints/s`);
  console.log(`  Helius keys used:`);
  for (const k of finalStats.keys) {
    console.log(`    #${k.index} ${k.keyPrefix}...  calls=${fmtNum(k.calls)} 429=${k.errors429} auth=${k.errors4xxAuth} other=${k.errorsOther}`);
  }
}

main().catch((err) => {
  console.error("[PARALLEL SCAN] fatal", err);
  process.exit(1);
});
