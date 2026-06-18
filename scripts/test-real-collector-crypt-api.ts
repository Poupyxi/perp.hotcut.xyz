#!/usr/bin/env node

/**
 * Real Collector Crypt API Test
 * Read-only validation of official endpoint
 */

async function testRealApi() {
  const baseUrl = "https://api.collectorcrypt.com";
  const endpoint = "/marketplace";
  const query = new URLSearchParams({
    categories: "Pokemon",
    marketplaceStatus: "Buy now",
    marketplaceSource: "CC",
    page: "1",
    step: "100",
  });

  const url = `${baseUrl}${endpoint}?${query.toString()}`;

  console.log("\n" + "=".repeat(70));
  console.log("REAL COLLECTOR CRYPT API TEST");
  console.log("=".repeat(70));

  console.log(`\nURL: ${url}`);
  console.log(`\nFetching page 1 with step=100...\n`);

  const startTime = Date.now();

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });

    const responseTime = Date.now() - startTime;

    console.log(`✓ HTTP Status: ${response.status} ${response.statusText}`);
    console.log(`✓ Response Time: ${responseTime}ms`);

    if (!response.ok) {
      console.error(`\n❌ HTTP Error: ${response.status}`);
      const text = await response.text();
      console.error(`Response: ${text.slice(0, 500)}`);
      process.exit(1);
    }

    const data = (await response.json()) as Record<string, unknown>;

    // Verify structure
    console.log(`\n✓ Response Structure:`);
    const topLevelKeys = Object.keys(data);
    console.log(`  Top-level keys: ${topLevelKeys.slice(0, 10).join(", ")}${topLevelKeys.length > 10 ? ", ..." : ""}`);

    // Check for listings array
    const listings = data.filterNFtCard;
    if (!Array.isArray(listings)) {
      console.error(`\n❌ Expected filterNFtCard array, got ${typeof listings}`);
      process.exit(1);
    }

    console.log(`\n✓ Listings Array:`);
    console.log(`  - Field name: filterNFtCard`);
    console.log(`  - Items returned: ${listings.length}`);

    // Check pagination info
    const total = data.findTotal;
    const totalPages = data.totalPages;

    console.log(`\n✓ Pagination Info:`);
    console.log(`  - findTotal: ${total}`);
    console.log(`  - totalPages: ${totalPages}`);
    console.log(`  - Page size: 100 (step parameter)`);

    // Analyze first listing
    if (listings.length > 0) {
      const firstListing = listings[0] as Record<string, unknown>;
      const listing = firstListing.listing as Record<string, unknown> || {};
      const owner = firstListing.owner as Record<string, unknown> || {};

      console.log(`\n✓ First Listing Mapping:`);
      console.log(`  - mint (nftAddress): ${firstListing.nftAddress}`);
      console.log(`  - listing ID (receiptId): ${listing.receiptId}`);
      console.log(`  - price: ${listing.price}`);
      console.log(`  - currency: ${listing.currency}`);
      console.log(`  - marketplace: ${listing.marketplace}`);
      console.log(`  - createdAt: ${listing.createdAt}`);
      console.log(`  - updatedAt: ${listing.updatedAt}`);
      console.log(`  - seller (owner.wallet): ${owner.wallet}`);
      console.log(`  - fallback seller (sellerId): ${listing.sellerId}`);

      // Check field presence
      console.log(`\n✓ Required Field Presence Check:`);

      const receiptIdPresent = listings.every(
        (l: unknown) => (l as Record<string, unknown>)?.listing?.receiptId,
      );
      console.log(`  - listing.receiptId always present: ${receiptIdPresent ? "✓ Yes" : "✗ No"}`);

      const ownerWalletPresent = listings.every(
        (l: unknown) => (l as Record<string, unknown>)?.owner?.wallet,
      );
      console.log(`  - owner.wallet always present: ${ownerWalletPresent ? "✓ Yes" : "✗ No"}`);

      if (!receiptIdPresent || !ownerWalletPresent) {
        console.warn("\n⚠️  Some required fields missing. Verify fallback logic needed.");
      }
    }

    // Summary
    console.log(`\n` + "=".repeat(70));
    console.log(`VALIDATION COMPLETE`);
    console.log("=".repeat(70));
    console.log(`\n✅ Real API is reachable and returns expected structure`);
    console.log(`\nSummary:`);
    console.log(`  - Endpoint: https://api.collectorcrypt.com/marketplace`);
    console.log(`  - Listings: ${listings.length} items in filterNFtCard`);
    console.log(`  - Total: ${total} total matching listings`);
    console.log(`  - Pages: ${totalPages} total pages`);
    console.log(`  - Response time: ${responseTime}ms`);
    console.log(`\nReady for snapshot synchronization.\n`);
  } catch (error) {
    console.error(`\n❌ API test failed:`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

testRealApi().catch(console.error);
