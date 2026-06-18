#!/usr/bin/env node

/**
 * Collector Crypt API validation test
 * Fetches one page to validate:
 * - Endpoint reachability
 * - Pagination field names
 * - Total count field
 * - Listing field structure
 * - Response structure
 */

async function testCollectorCryptApi() {
  const baseUrl = process.env.COLLECTOR_CRYPT_API_URL;
  const listingsPath = process.env.COLLECTOR_CRYPT_LISTINGS_PATH || "/listings";

  if (!baseUrl) {
    console.error("❌ COLLECTOR_CRYPT_API_URL not configured");
    process.exit(1);
  }

  console.log("[Collector Crypt API Test]\n");
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Listings path: ${listingsPath}`);

  try {
    // Build URL for page 1 with limit
    const url = new URL(listingsPath, baseUrl);
    url.searchParams.set("page", "1");
    url.searchParams.set("limit", "100");

    console.log(`Full endpoint: ${url.toString()}\n`);
    console.log("Fetching page 1...\n");

    const response = await fetch(url.toString(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    console.log(`HTTP Status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      console.error(`❌ HTTP error: ${response.status}`);
      const text = await response.text();
      console.error(`Response: ${text.slice(0, 500)}`);
      process.exit(1);
    }

    const data = await response.json() as unknown;

    // Analyze structure
    if (!data || typeof data !== "object") {
      console.error(`❌ Invalid response structure: ${typeof data}`);
      process.exit(1);
    }

    const obj = data as Record<string, unknown>;
    console.log(`\nResponse structure:`);
    console.log(`- Top-level keys: ${Object.keys(obj).join(", ")}`);

    // Check for listings array
    let listings: unknown[] = [];
    if (Array.isArray(obj.listings)) {
      listings = obj.listings;
      console.log(`- Found: obj.listings (array)`);
    } else if (Array.isArray(obj.data)) {
      listings = obj.data;
      console.log(`- Found: obj.data (array)`);
    } else if (Array.isArray(obj.items)) {
      listings = obj.items;
      console.log(`- Found: obj.items (array)`);
    } else if (Array.isArray(data)) {
      listings = data as unknown[];
      console.log(`- Response is array`);
    } else {
      console.warn(`⚠️  Could not find listings array. Keys: ${Object.keys(obj).join(", ")}`);
    }

    console.log(`\nListings returned: ${listings.length}`);

    // Check pagination fields
    const paginationFields = {
      total: obj.total,
      totalPages: obj.total_pages || obj.totalPages || obj.pages,
      currentPage: obj.page || obj.current_page,
      pageSize: obj.limit || obj.page_size,
      hasMore: obj.has_more || obj.hasMore,
    };

    console.log(`\nPagination info:`);
    for (const [key, value] of Object.entries(paginationFields)) {
      if (value !== undefined) {
        console.log(`- ${key}: ${value}`);
      }
    }

    // Analyze first listing
    if (listings.length > 0) {
      const first = listings[0];
      if (first && typeof first === "object") {
        const listing = first as Record<string, unknown>;
        const requiredFields = ["mint", "listing_id", "price", "seller"];
        const fieldsFound = Object.keys(listing).filter((k) => requiredFields.includes(k));

        console.log(`\nFirst listing fields:`);
        console.log(`- All keys: ${Object.keys(listing).slice(0, 10).join(", ")}${Object.keys(listing).length > 10 ? ", ..." : ""}`);
        console.log(`- Required fields found: ${fieldsFound.join(", ")}`);
        console.log(`- Missing: ${requiredFields.filter((f) => !fieldsFound.includes(f)).join(", ")}`);

        // Sample field values (non-sensitive)
        const sampleData = {
          mint: typeof listing.mint === "string" ? listing.mint.slice(0, 8) + "..." : "N/A",
          listing_id: typeof listing.listing_id === "string" ? listing.listing_id.slice(0, 8) + "..." : listing.listing_id,
          price: listing.price,
          currency: listing.currency,
          seller: typeof listing.seller === "string" ? listing.seller.slice(0, 8) + "..." : "N/A",
        };
        console.log(`\nSample data (truncated):`);
        for (const [key, value] of Object.entries(sampleData)) {
          console.log(`- ${key}: ${value}`);
        }
      }
    }

    console.log("\n✅ API test completed successfully");
    console.log("\nNext steps:");
    console.log("1. Verify all pagination fields are correctly mapped");
    console.log("2. Confirm total count matches announced pages");
    console.log("3. Update COLLECTOR_CRYPT_LISTINGS_PATH if needed");
    console.log("4. Run full snapshot sync");
  } catch (error) {
    console.error(`\n❌ API test failed:`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

testCollectorCryptApi().catch(console.error);
