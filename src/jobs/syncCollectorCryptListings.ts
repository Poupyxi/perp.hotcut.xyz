import { syncCollectorCryptSnapshot } from "@/services/collectorCryptListingSnapshotService";

export async function syncCollectorCryptListings() {
  console.log("[Collector Crypt] Starting listing sync");
  try {
    const result = await syncCollectorCryptSnapshot();
    console.log(`[Collector Crypt] Sync complete: ${result.listingsStored} listings, ${result.disappearedCount} disappeared`);
    return result;
  } catch (error) {
    console.error("[Collector Crypt] Sync failed:", error instanceof Error ? error.message : "unknown error");
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncCollectorCryptListings()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
