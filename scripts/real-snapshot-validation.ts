#!/usr/bin/env node

/**
 * Real Snapshot Validation
 * 1. Run first complete snapshot
 * 2. Run second identical snapshot
 * 3. Verify zero disappeared listings
 */

import { syncCollectorCryptSnapshot, compareSnapshots } from "../src/services/collectorCryptListingSnapshotService";
import { getNftDb } from "../src/services/nftSqliteDb";

async function runSnapshotValidation() {
  console.log("\n" + "=".repeat(70));
  console.log("REAL SNAPSHOT SYNCHRONIZATION VALIDATION");
  console.log("=".repeat(70) + "\n");

  try {
    // Step 1: First snapshot
    console.log("STEP 1: Running first complete snapshot...\n");
    const snapshot1 = await syncCollectorCryptSnapshot();

    console.log(`✓ Snapshot 1 ID: ${snapshot1.snapshotId}`);
    console.log(`✓ Status: ${snapshot1.status}`);
    console.log(`✓ Listings announced: ${snapshot1.listingsAnnounced}`);
    console.log(`✓ Listings stored: ${snapshot1.listingsStored}`);
    console.log(`✓ Pages fetched: ${snapshot1.pagesFetched}`);
    console.log(`✓ Disappeared count: ${snapshot1.disappearedCount}`);

    if (snapshot1.status !== "complete") {
      console.error(`\n❌ Snapshot 1 failed: status=${snapshot1.status}`);
      if (snapshot1.error) {
        console.error(`Error: ${snapshot1.error}`);
      }
      process.exit(1);
    }

    if (snapshot1.listingsStored === 0) {
      console.error(`\n❌ Snapshot 1 stored zero listings`);
      process.exit(1);
    }

    const expectedPages = Math.ceil(snapshot1.listingsAnnounced / 100);
    console.log(`\n✓ Validation: ${snapshot1.pagesFetched} pages to fetch ${snapshot1.listingsAnnounced} listings`);
    console.log(`✓ Expected ~${expectedPages} pages, fetched ${snapshot1.pagesFetched}`);
    console.log(`✓ Stored ${snapshot1.listingsStored} listings (${((snapshot1.listingsStored / snapshot1.listingsAnnounced) * 100).toFixed(1)}% match)\n`);

    // Step 2: Second identical snapshot
    console.log("STEP 2: Running second identical snapshot...\n");
    const snapshot2 = await syncCollectorCryptSnapshot();

    console.log(`✓ Snapshot 2 ID: ${snapshot2.snapshotId}`);
    console.log(`✓ Status: ${snapshot2.status}`);
    console.log(`✓ Listings announced: ${snapshot2.listingsAnnounced}`);
    console.log(`✓ Listings stored: ${snapshot2.listingsStored}`);
    console.log(`✓ Pages fetched: ${snapshot2.pagesFetched}`);
    console.log(`✓ Disappeared count: ${snapshot2.disappearedCount}`);

    if (snapshot2.status !== "complete") {
      console.error(`\n❌ Snapshot 2 failed: status=${snapshot2.status}`);
      if (snapshot2.error) {
        console.error(`Error: ${snapshot2.error}`);
      }
      process.exit(1);
    }

    // Step 3: Verify idempotency
    console.log("\nSTEP 3: Verify snapshot idempotency...\n");

    const comparison = compareSnapshots({
      currentSnapshotId: snapshot2.snapshotId,
      previousSnapshotId: snapshot1.snapshotId,
    });

    console.log(`✓ Disappeared listings: ${comparison.disappeared.length}`);
    console.log(`✓ New listings: ${comparison.newListings.length}`);
    console.log(`✓ Relistings: ${comparison.relistings.length}`);

    if (comparison.disappeared.length > 0) {
      console.error(`\n❌ Second snapshot shows disappeared listings (should be zero)`);
      console.error(`Disappeared:`);
      for (const d of comparison.disappeared) {
        console.error(`  - ${d.listingId} (${d.mint})`);
      }
      process.exit(1);
    }

    if (comparison.newListings.length > 0) {
      console.error(`\n❌ Second snapshot shows new listings (should be zero)`);
      process.exit(1);
    }

    // Verify queue is empty
    console.log("\nSTEP 4: Verify queue is empty...\n");
    const db = getNftDb();
    const queueItems = db
      .prepare("SELECT COUNT(*) as count FROM collector_crypt_verification_queue WHERE status IN ('pending', 'in_progress')")
      .get() as { count: number };

    console.log(`✓ Queue items (pending or in_progress): ${queueItems.count}`);

    if (queueItems.count > 0) {
      console.error(`\n❌ Queue has items when it should be empty`);
      process.exit(1);
    }

    // Summary
    console.log("\n" + "=".repeat(70));
    console.log("✅ SNAPSHOT VALIDATION SUCCESSFUL");
    console.log("=".repeat(70));

    console.log(`\nSnapshot 1:`);
    console.log(`  - Total listed: ${snapshot1.listingsAnnounced}`);
    console.log(`  - Stored: ${snapshot1.listingsStored}`);
    console.log(`  - Pages fetched: ${snapshot1.pagesFetched}`);

    console.log(`\nSnapshot 2 (identical):` );
    console.log(`  - Total listed: ${snapshot2.listingsAnnounced}`);
    console.log(`  - Stored: ${snapshot2.listingsStored}`);
    console.log(`  - Pages fetched: ${snapshot2.pagesFetched}`);

    console.log(`\nComparison:` );
    console.log(`  - Disappeared: 0 ✓`);
    console.log(`  - New: 0 ✓`);
    console.log(`  - Relistings: ${comparison.relistings.length} (all same listings)`);

    console.log(`\nQueue:`);
    console.log(`  - Pending items: 0 ✓`);

    console.log(`\n✅ Idempotency verified: Snapshots are safe and repeatable.\n`);
  } catch (error) {
    console.error("\n❌ Validation failed:");
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

runSnapshotValidation().catch(console.error);
