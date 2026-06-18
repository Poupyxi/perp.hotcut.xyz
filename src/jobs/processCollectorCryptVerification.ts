import { processCollectorCryptVerificationQueue } from "@/services/collectorCryptVerificationService";

export async function processCollectorCryptVerification() {
  console.log("[Collector Crypt Verification] Starting queue processing");
  try {
    const result = await processCollectorCryptVerificationQueue();
    if (result.processed > 0) {
      console.log(
        `[Collector Crypt Verification] Processed: ${result.processed}, Resolved: ${result.resolved}, Remaining: ${result.queued}`,
      );
    }
    if (result.errors.length > 0) {
      console.error(`[Collector Crypt Verification] ${result.errors.length} errors:`, result.errors);
    }
    return result;
  } catch (error) {
    console.error("[Collector Crypt Verification] Queue processing failed:", error instanceof Error ? error.message : "unknown error");
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  processCollectorCryptVerification()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
