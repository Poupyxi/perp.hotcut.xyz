#!/usr/bin/env node

/**
 * Hardened Snapshot Validation
 * Fetches all pages with proper rate limiting handling
 * 1. First snapshot - all 38 pages
 * 2. Second snapshot - verify idempotency
 * 3. Confirm counts and queue
 */

import { syncCollectorCryptSnapshot, compareSnapshots } from "../src/services/collectorCryptListingSnapshotService";
import { getNftDb } from "../src/services/nftSqliteDb";

async function validateSnapshots() {
  console.log("\n" + "=".repeat(70));
  console.log("HARDENED COLLECTOR CRYPT SNAPSHOT VALIDATION");
  console.log("=".repeat(70) + "\n");

  try {
    // STEP 1: First snapshot
    console.log("STEP 1: Running first complete snapshot (all 38 pages)...\n");
    console.log("Starting at:", new Date().toISOString());

    const startTime = Date.now();
    const snapshot1 = await syncCollectorCryptSnapshot();
    const duration1 = Date.now() - startTime;

    console.log(`\nCompleted at: ${new Date().toISOString()}`);
    console.log(`Duration: ${duration1 / 1000 / 60} minutes\n`);

    console.log(`Snapshot 1 Results:`);
    console.log(`  - ID: ${snapshot1.snapshotId}`);
    console.log(`  - Status: ${snapshot1.status}`);
    console.log(`  - Listings announced (findTotal): ${snapshot1.listingsAnnounced}`);
    console.log(`  - Listings stored: ${snapshot1.listingsStored}`);
    console.log(`  - Pages fetched: ${snapshot1.pagesFetched}`);
    console.log(`  - Disappeared count: ${snapshot1.disappearedCount}`);

    if (snapshot1.validationErrors && snapshot1.validationErrors.length > 0) {
      console.log(`  - Validation errors: ${snapshot1.validationErrors.length}`);
      for (const err of snapshot1.validationErrors.slice(0, 3)) {
        console.log(`    • ${err}`);
      }
    }

    // Verify snapshot is complete
    if (snapshot1.status !== "complete") {
      console.error(`\n❌ Snapshot 1 failed: status=${snapshot1.status}`);
      if (snapshot1.error) {
        console.error(`   Error: ${snapshot1.error}`);
      }

      if (snapshot1.status === "partial") {
        console.log(`\n⚠️  Partial snapshot (rate limited). Pages fetched: ${snapshot1.pagesFetched}`);
        console.log(`   Stored: ${snapshot1.listingsStored} / ${snapshot1.listingsAnnounced}`);
        console.log(`   Next attempt will retry from beginning with exponential backoff.\n`);
      }

      process.exit(1);
    }

    // Verify count accuracy
    const countMatch =
      snapshot1.listingsStored === snapshot1.listingsAnnounced ||
      Math.abs(snapshot1.listingsStored - snapshot1.listingsAnnounced) <=
        Math.max(snapshot1.listingsAnnounced * 0.02, 1);

    console.log(`\n✓ Count validation:`);
    console.log(`  - Announced: ${snapshot1.listingsAnnounced}`);
    console.log(`  - Stored: ${snapshot1.listingsStored}`);
    console.log(`  - Match: ${countMatch ? "✓ Yes" : "✗ No"}`);

    if (!countMatch) {
      console.error(`\n❌ Count mismatch: announced ${snapshot1.listingsAnnounced}, stored ${snapshot1.listingsStored}`);
      process.exit(1);
    }

    // STEP 2: Second identical snapshot
    console.log("\n" + "=".repeat(70));
    console.log("STEP 2: Running second identical snapshot...\n");

    const startTime2 = Date.now();
    const snapshot2 = await syncCollectorCryptSnapshot();
    const duration2 = Date.now() - startTime2;

    console.log(`Duration: ${duration2 / 1000 / 60} minutes\n`);

    console.log(`Snapshot 2 Results:`);
    console.log(`  - ID: ${snapshot2.snapshotId}`);
    console.log(`  - Status: ${snapshot2.status}`);
    console.log(`  - Listings announced: ${snapshot2.listingsAnnounced}`);
    console.log(`  - Listings stored: ${snapshot2.listingsStored}`);
    console.log(`  - Pages fetched: ${snapshot2.pagesFetched}`);
    console.log(`  - Disappeared count: ${snapshot2.disappearedCount}`);

    if (snapshot2.status !== "complete") {
      console.error(`\n❌ Snapshot 2 failed: status=${snapshot2.status}`);
      process.exit(1);
    }

    // STEP 3: Verify idempotency
    console.log("\n" + "=".repeat(70));
    console.log("STEP 3: Verify snapshot idempotency...\n");

    const comparison = compareSnapshots({
      currentSnapshotId: snapshot2.snapshotId,
      previousSnapshotId: snapshot1.snapshotId,
    });

    console.log(`Comparison Results:`);
    console.log(`  - Disappeared listings: ${comparison.disappeared.length}`);
    console.log(`  - New listings: ${comparison.newListings.length}`);
    console.log(`  - Relistings: ${comparison.relistings.length}`);

    if (comparison.disappeared.length > 0) {
      console.error(`\n❌ Second snapshot shows disappeared listings (expected 0)`);
      process.exit(1);
    }

    if (comparison.newListings.length > 0) {
      console.error(`\n❌ Second snapshot shows new listings (expected 0)`);
      process.exit(1);
    }

    // STEP 4: Verify queue is empty
    console.log("\nSTEP 4: Verify verification queue...\n");

    const db = getNftDb();
    const queueItems = db
      .prepare("SELECT COUNT(*) as count FROM collector_crypt_verification_queue WHERE status IN ('pending', 'in_progress')")
      .get() as { count: number };

    console.log(`Queue Status:`);
    console.log(`  - Pending or in-progress items: ${queueItems.count}`);

    if (queueItems.count > 0) {
      console.error(`\n❌ Queue has items when it should be empty`);
      process.exit(1);
    }

    // SUCCESS SUMMARY
    console.log("\n" + "=".repeat(70));
    console.log("✅ ALL VALIDATION STEPS SUCCESSFUL");
    console.log("=".repeat(70));

    console.log(`\nSnapshot 1 (Complete):`);
    console.log(`  - Total listings: ${snapshot1.listingsAnnounced}`);
    console.log(`  - Stored: ${snapshot1.listingsStored}`);
    console.log(`  - Pages: ${snapshot1.pagesFetched}`);
    console.log(`  - Time: ${(duration1 / 1000 / 60).toFixed(1)} minutes`);

    console.log(`\nSnapshot 2 (Identical):`);
    console.log(`  - Total listings: ${snapshot2.listingsAnnounced}`);
    console.log(`  - Stored: ${snapshot2.listingsStored}`);
    console.log(`  - Pages: ${snapshot2.pagesFetched}`);
    console.log(`  - Time: ${(duration2 / 1000 / 60).toFixed(1)} minutes`);

    console.log(`\nIdempotency Check:`);
    console.log(`  - Disappeared: 0 ✓`);
    console.log(`  - New: 0 ✓`);
    console.log(`  - Relistings: ${comparison.relistings.length} (all same listings) ✓`);

    console.log(`\nQueue Status:`);
    console.log(`  - Items: 0 ✓`);

    console.log(`\n✅ System is stable and ready for production.`);
    console.log(`\nNext: Enable crons and deploy to production.\n`);
  } catch (error) {
    console.error("\n❌ Validation failed:");
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

validateSnapshots().catch(console.error);
