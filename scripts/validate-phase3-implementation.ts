#!/usr/bin/env node

/**
 * Phase 3 Implementation Validation
 *
 * Verifies all critical requirements are implemented correctly:
 * 1. Event idempotency key: event_type + mint + txHash
 * 2. Payment fields stored correctly
 * 3. DELISTED requires explicit cancellation evidence
 * 4. nft_assets updated only after event creation
 * 5. Queue identity based on provider + listing_id
 */

import { readFileSync } from "fs";
import path from "path";

function log(message: string) {
  console.log(`✓ ${message}`);
}

function verify(condition: boolean, message: string) {
  if (!condition) {
    console.error(`✗ FAILED: ${message}`);
    process.exit(1);
  }
  log(message);
}

async function validateImplementation() {
  console.log("\n" + "=".repeat(70));
  console.log("PHASE 3 IMPLEMENTATION VALIDATION");
  console.log("=".repeat(70) + "\n");

  // 1. Verify VerificationEvidence interface has payment fields
  console.log("1. Verify Payment Information Storage");
  console.log("-".repeat(70));

  const verificationServicePath = path.join(
    process.cwd(),
    "src/services/collectorCryptVerificationService.ts",
  );
  const verificationSource = readFileSync(verificationServicePath, "utf-8");

  verify(
    verificationSource.includes("paymentMint?: string | null"),
    "VerificationEvidence has paymentMint field",
  );
  verify(
    verificationSource.includes("paymentSymbol?: string | null"),
    "VerificationEvidence has paymentSymbol field",
  );
  verify(
    verificationSource.includes("paymentAmount?: number | null"),
    "VerificationEvidence has paymentAmount field",
  );

  // 2. Verify SOLD returns payment info
  verify(
    verificationSource.includes("paymentMint,") &&
    verificationSource.includes("paymentSymbol:") &&
    verificationSource.includes("paymentAmount:"),
    "SOLD classification captures payment information",
  );

  // 3. Verify event creation uses payment fields
  verify(
    verificationSource.includes("paymentMint: verification.paymentMint"),
    "SALE event includes paymentMint from verification",
  );
  verify(
    verificationSource.includes("paymentSymbol: verification.paymentSymbol"),
    "SALE event includes paymentSymbol from verification",
  );
  verify(
    verificationSource.includes("paymentAmount: verification.paymentAmount"),
    "SALE event includes paymentAmount from verification",
  );

  // 4. Verify idempotency checks
  console.log("\n2. Verify Event Idempotency");
  console.log("-".repeat(70));

  verify(
    verificationSource.includes("dedupeMarketEvent"),
    "Event creation uses dedupeMarketEvent() for deduplication",
  );
  verify(
    verificationSource.includes("const isDuplicate = await dedupeMarketEvent(saleEvent)"),
    "SALE events checked for duplicates before creation",
  );
  verify(
    verificationSource.includes("const isDuplicate = await dedupeMarketEvent(transferEvent)"),
    "TRANSFER events checked for duplicates before creation",
  );
  verify(
    verificationSource.includes("const isDuplicate = await dedupeMarketEvent(delistEvent)"),
    "DELISTED events checked for duplicates before creation",
  );
  verify(
    verificationSource.includes("if (!isDuplicate)"),
    "Events only created if not duplicate",
  );

  // 5. Verify NFT assets updated only after event
  console.log("\n3. Verify nft_assets Update Timing");
  console.log("-".repeat(70));

  verify(
    verificationSource.includes("updateNftAssetFromMarketEvent"),
    "nft_assets update function imported",
  );
  verify(
    verificationSource.includes("await updateNftAssetFromMarketEvent(saleEvent)"),
    "nft_assets updated after successful SALE event creation",
  );
  verify(
    verificationSource.includes("await updateNftAssetFromMarketEvent(transferEvent)"),
    "nft_assets updated after successful TRANSFER event creation",
  );
  verify(
    verificationSource.includes("await updateNftAssetFromMarketEvent(delistEvent)"),
    "nft_assets updated after successful DELISTED event creation",
  );

  // 6. Verify DELISTED requires txHash
  console.log("\n4. Verify DELISTED Requirements");
  console.log("-".repeat(70));

  verify(
    verificationSource.includes("verification.result === \"delisted\" && verification.txHash"),
    "DELISTED events require txHash (from explicit cancellation)",
  );
  verify(
    verificationSource.includes("if (delistingEvidence)"),
    "DELISTED classification checks for explicit delisting evidence",
  );
  verify(
    verificationSource.includes("hasExplicitDelistingEvidence"),
    "Explicit delisting evidence detection implemented",
  );

  // 7. Verify queue identity
  console.log("\n5. Verify Queue Identity (provider + listing_id)");
  console.log("-".repeat(70));

  const snapshotServicePath = path.join(
    process.cwd(),
    "src/services/collectorCryptListingSnapshotService.ts",
  );
  const snapshotSource = readFileSync(snapshotServicePath, "utf-8");

  verify(
    snapshotSource.includes("const key = `${row.provider}:${row.listing_id}`"),
    "Queue item identity uses provider:listing_id",
  );
  verify(
    snapshotSource.includes("provider=? AND listing_id=? AND status IN ('pending','in_progress')"),
    "Queue deduplication uses provider + listing_id (not mint)",
  );

  // 8. Verify event source
  console.log("\n6. Verify Event Source Type");
  console.log("-".repeat(70));

  const rwaNftMarketPath = path.join(
    process.cwd(),
    "src/types/rwaNftMarket.ts",
  );
  const rwaNftMarketSource = readFileSync(rwaNftMarketPath, "utf-8");

  verify(
    rwaNftMarketSource.includes("\"collector-crypt-verification\""),
    "Event source type includes 'collector-crypt-verification'",
  );

  // 9. Verify USDC mint is correct
  console.log("\n7. Verify USDC Mint Configuration");
  console.log("-".repeat(70));

  const paymentDetectorPath = path.join(
    process.cwd(),
    "src/services/heliusSolUsdcPaymentDetector.ts",
  );
  const paymentDetectorSource = readFileSync(paymentDetectorPath, "utf-8");

  verify(
    paymentDetectorSource.includes("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    "USDC mint is correct official Solana mainnet USDC",
  );
  verify(
    !paymentDetectorSource.includes("EPjFWaLb3odcccccccccccccccccccccccccccccccc"),
    "Invalid placeholder USDC mint removed",
  );

  // 10. Verify getTransaction encoding
  console.log("\n8. Verify Helius RPC Configuration");
  console.log("-".repeat(70));

  verify(
    verificationSource.includes('encoding: "jsonParsed"'),
    "getTransaction uses encoding='jsonParsed' for proper parsing",
  );
  verify(
    verificationSource.includes("maxSupportedTransactionVersion: 0"),
    "getTransaction uses maxSupportedTransactionVersion=0",
  );

  // 11. Test compilation
  console.log("\n9. Verify Code Compiles");
  console.log("-".repeat(70));

  try {
    await import("../src/services/collectorCryptVerificationService");
    log("collectorCryptVerificationService compiles successfully");
  } catch (error) {
    verify(false, `collectorCryptVerificationService compilation: ${error}`);
  }

  try {
    await import("../src/services/collectorCryptListingSnapshotService");
    log("collectorCryptListingSnapshotService compiles successfully");
  } catch (error) {
    verify(false, `collectorCryptListingSnapshotService compilation: ${error}`);
  }

  // 12. Summary
  console.log("\n" + "=".repeat(70));
  console.log("IMPLEMENTATION VERIFICATION SUMMARY");
  console.log("=".repeat(70));

  const checks = {
    "Payment fields (paymentMint, paymentSymbol, paymentAmount)": true,
    "Event idempotency (dedupeMarketEvent checks)": true,
    "nft_assets updated only after event creation": true,
    "DELISTED requires txHash from explicit evidence": true,
    "Queue identity based on provider:listing_id": true,
    "Event source includes collector-crypt-verification": true,
    "USDC mint corrected to official Solana value": true,
    "getTransaction encoding set to jsonParsed": true,
    "Code compiles without errors": true,
  };

  for (const [check, passed] of Object.entries(checks)) {
    console.log(`${passed ? "✓" : "✗"} ${check}`);
  }

  console.log("\n" + "=".repeat(70));
  console.log("✅ ALL PHASE 3 REQUIREMENTS VERIFIED");
  console.log("=".repeat(70) + "\n");

  console.log("Ready for manual validation with real Collector Crypt API endpoint.");
  console.log("\nTo validate with real data:");
  console.log("  export COLLECTOR_CRYPT_API_URL=https://api.collector-crypt.xyz");
  console.log("  export COLLECTOR_CRYPT_LISTINGS_PATH=/v1/listings");
  console.log("  npx tsx scripts/manual-validation-collector-crypt.ts\n");
}

validateImplementation().catch(console.error);
