import type { RwaNftMarketEvent } from "@/types/rwaNftMarket";
import { getNftDb } from "./nftSqliteDb";
import { fetchWithHeliusKey, hasHeliusApiKey } from "./heliusApiKeyRotation";
import { saveRwaNftMarketEvent } from "./rwaNftMarketEventService";
import { isCompressedNft, isCompressedNftTransfer } from "./heliusCompressedNftParser";
import { hasValidPaymentEvidence, analyzePaymentEvidence } from "./heliusSolUsdcPaymentDetector";

export type VerificationResult = "sold" | "transferred" | "delisted" | "unknown";

export interface VerificationEvidence {
  result: VerificationResult;
  txHash: string | null;
  timestamp: string | null;
  manualReview: boolean;
  evidence: string[];
}

interface HeliusAsset {
  id: string;
  ownership?: {
    owner: string;
    delegated: boolean;
    frozen: boolean;
  };
  state?: string;
  [key: string]: unknown;
}

interface HeliusSignaturesResponse {
  result: Array<{
    signature: string;
    blockTime?: number;
    err?: string | null;
  }>;
}

interface HeliusTransaction {
  signature: string;
  blockTime?: number;
  slot?: number;
  [key: string]: unknown;
}

const RETRY_DELAYS = [0, 30_000, 120_000]; // immediate, 30s, 2min
const MAX_ATTEMPTS = 3;

async function getHeliusAsset(mint: string): Promise<{ asset: HeliusAsset | null; error?: string }> {
  if (!hasHeliusApiKey()) return { asset: null, error: "No Helius API key available" };

  try {
    const response = await fetchWithHeliusKey({
      label: "collector-crypt-get-asset",
      endpoint: "https://mainnet-core.helius-rpc.com/",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "get-asset",
          method: "getAsset",
          params: {
            id: mint,
            displayOptions: {
              showFungible: false,
            },
          },
        }),
      },
    });

    const data = (await response.json()) as { result?: HeliusAsset; error?: { message: string } };

    if (data.error) {
      return { asset: null, error: data.error.message };
    }

    return { asset: data.result || null };
  } catch (error) {
    return { asset: null, error: error instanceof Error ? error.message : "Network error" };
  }
}

async function getHeliusSignaturesForAsset(mint: string): Promise<{ signatures: string[]; error?: string }> {
  if (!hasHeliusApiKey()) return { signatures: [], error: "No Helius API key available" };

  try {
    const response = await fetchWithHeliusKey({
      label: "collector-crypt-signatures-for-asset",
      endpoint: "https://mainnet-core.helius-rpc.com/",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "get-signatures",
          method: "getSignaturesForAsset",
          params: {
            id: mint,
            limit: 100, // Fetch up to 100 recent signatures
          },
        }),
      },
    });

    const data = (await response.json()) as HeliusSignaturesResponse | { error?: { message: string } };

    if ("error" in data && data.error) {
      return { signatures: [], error: data.error.message };
    }

    const result = (data as HeliusSignaturesResponse).result || [];
    const signatures = result
      .filter((tx) => tx.err === null) // Only confirmed transactions
      .map((tx) => tx.signature);

    return { signatures };
  } catch (error) {
    return { signatures: [], error: error instanceof Error ? error.message : "Network error" };
  }
}

function checkStandardNftTransfer(tx: unknown): boolean {
  if (!tx || typeof tx !== "object") return false;

  const txObj = tx as HeliusTransaction;

  // Standard NFT transfer: check for token transfers
  if (txObj.meta && typeof txObj.meta === "object") {
    const meta = txObj.meta as { postTokenBalances?: unknown[] };
    if (Array.isArray(meta.postTokenBalances) && meta.postTokenBalances.length > 0) {
      return true; // Token movement detected
    }
  }

  return false;
}

async function getHeliusTransaction(signature: string): Promise<{ tx: HeliusTransaction | null; error?: string }> {
  if (!hasHeliusApiKey()) return { tx: null, error: "No Helius API key available" };

  try {
    const response = await fetchWithHeliusKey({
      label: "collector-crypt-get-transaction",
      endpoint: "https://mainnet-core.helius-rpc.com/",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "get-transaction",
          method: "getTransaction",
          params: [
            signature,
            {
              encoding: "json",
              maxSupportedTransactionVersion: 0,
            },
          ],
        }),
      },
    });

    const data = (await response.json()) as { result?: HeliusTransaction; error?: { message: string } };

    if (data.error) {
      return { tx: null, error: data.error.message };
    }

    return { tx: data.result || null };
  } catch (error) {
    return { tx: null, error: error instanceof Error ? error.message : "Network error" };
  }
}

export async function verifyDisappearedListing(input: {
  mint: string;
  previousListing?: {
    price?: number;
    listedAt?: string;
    seller?: string;
  };
  previousOwner?: string;
}): Promise<VerificationEvidence> {
  const evidence: string[] = [];

  // Step 1: Get current asset info and owner
  const assetResult = await getHeliusAsset(input.mint);
  if (assetResult.error) {
    evidence.push(`Asset lookup failed: ${assetResult.error}`);
    return {
      result: "unknown",
      txHash: null,
      timestamp: null,
      manualReview: true,
      evidence,
    };
  }

  if (!assetResult.asset) {
    evidence.push("Asset not found on blockchain");
    return {
      result: "unknown",
      txHash: null,
      timestamp: null,
      manualReview: true,
      evidence,
    };
  }

  const asset = assetResult.asset;
  const isCompressed = isCompressedNft(asset);
  if (isCompressed) {
    evidence.push("Asset is a compressed NFT (cNFT)");
  }

  const currentOwner = asset.ownership?.owner || null;
  const ownerChanged = input.previousOwner && currentOwner && input.previousOwner !== currentOwner;

  if (ownerChanged) {
    evidence.push(`Owner changed: ${input.previousOwner} → ${currentOwner}`);
  } else if (currentOwner === input.previousOwner) {
    evidence.push(`Owner unchanged: ${currentOwner}`);
  }

  // Step 2: Get recent signatures
  const signaturesResult = await getHeliusSignaturesForAsset(input.mint);
  if (signaturesResult.error) {
    evidence.push(`Signature lookup failed: ${signaturesResult.error}`);
  }

  if (signaturesResult.signatures.length === 0) {
    evidence.push("No recent transactions found");
    if (!ownerChanged) {
      // Owner unchanged + no recent activity = delisted
      return {
        result: "delisted",
        txHash: null,
        timestamp: null,
        manualReview: false,
        evidence,
      };
    } else {
      // Owner changed but no transactions = insufficient evidence
      return {
        result: "unknown",
        txHash: null,
        timestamp: null,
        manualReview: true,
        evidence,
      };
    }
  }

  // Step 3: Analyze recent transactions (top 5)
  let bestSaleCandidate: {
    signature: string;
    hasNftTransfer: boolean;
    hasValidPayment: boolean;
    paymentType?: string; // "SOL" or "USDC"
    paymentAmount?: number;
    timestamp: string | null;
  } | null = null;

  let bestTransferCandidate: {
    signature: string;
    timestamp: string | null;
  } | null = null;

  let hasRecentActivity = false;

  for (const sig of signaturesResult.signatures.slice(0, 5)) {
    const txResult = await getHeliusTransaction(sig);

    if (txResult.error) {
      evidence.push(`Transaction ${sig} fetch failed: ${txResult.error}`);
      continue;
    }

    if (!txResult.tx) continue;

    const tx = txResult.tx;
    hasRecentActivity = true;

    // Detect NFT transfer (standard or compressed)
    const hasNftTransfer = isCompressed ? isCompressedNftTransfer(tx) : checkStandardNftTransfer(tx);

    if (!hasNftTransfer) continue;

    evidence.push(`NFT transfer detected in ${sig}`);

    // Analyze payment using balance comparison (SOL/USDC only)
    const paymentEvidence = analyzePaymentEvidence(tx);
    const hasValidPayment = paymentEvidence.hasSolPayment || paymentEvidence.hasUsdcPayment;

    if (hasValidPayment) {
      const paymentType = paymentEvidence.hasSolPayment ? "SOL" : "USDC";
      const paymentAmount = paymentEvidence.hasSolPayment
        ? paymentEvidence.solAmount / 1_000_000_000 // Convert lamports to SOL
        : paymentEvidence.usdcAmount; // Already in USDC units

      evidence.push(`✓ Valid ${paymentType} payment detected: ${paymentAmount} in ${sig}`);

      if (!bestSaleCandidate) {
        const timestamp = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null;
        bestSaleCandidate = {
          signature: sig,
          hasNftTransfer: true,
          hasValidPayment: true,
          paymentType,
          paymentAmount,
          timestamp,
        };
      }
    } else {
      evidence.push(`Transfer detected but no valid SOL/USDC payment in ${sig}`);

      if (!bestTransferCandidate) {
        const timestamp = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null;
        bestTransferCandidate = {
          signature: sig,
          timestamp,
        };
      }
    }

    // Early exit if we found a clear sale (both transfer + valid payment)
    if (bestSaleCandidate?.hasValidPayment) break;
  }

  // Step 4: Classification logic (strict rules)
  if (ownerChanged) {
    // SOLD: owner changed + NFT transfer + valid SOL/USDC payment
    if (bestSaleCandidate?.hasValidPayment && bestSaleCandidate?.hasNftTransfer) {
      evidence.push(`✓ SOLD: Owner changed + NFT transfer + ${bestSaleCandidate.paymentType} payment`);
      return {
        result: "sold",
        txHash: bestSaleCandidate.signature,
        timestamp: bestSaleCandidate.timestamp,
        manualReview: false,
        evidence,
      };
    }

    // TRANSFERRED: owner changed + NFT transfer + no valid payment
    if (bestTransferCandidate && !bestSaleCandidate?.hasValidPayment) {
      evidence.push("⚠ TRANSFERRED: Owner changed + NFT transfer + NO valid SOL/USDC payment");
      return {
        result: "transferred",
        txHash: bestTransferCandidate.signature,
        timestamp: bestTransferCandidate.timestamp,
        manualReview: false,
        evidence,
      };
    }

    // UNKNOWN: owner changed but insufficient evidence
    if (hasRecentActivity) {
      evidence.push("✗ UNKNOWN: Owner changed but transfer/payment evidence incomplete");
    } else {
      evidence.push("✗ UNKNOWN: Owner changed but no recent activity");
    }

    return {
      result: "unknown",
      txHash: null,
      timestamp: null,
      manualReview: true,
      evidence,
    };
  } else {
    // Owner unchanged
    if (hasRecentActivity) {
      evidence.push("⚠ Activity detected but owner unchanged");
    }

    // DELISTED: owner unchanged + listing disappeared
    return {
      result: "delisted",
      txHash: null,
      timestamp: null,
      manualReview: false,
      evidence,
    };
  }
}

export async function processCollectorCryptVerificationQueue(): Promise<{
  processed: number;
  resolved: number;
  queued: number;
  errors: Array<{ mint: string; error: string }>;
}> {
  const db = getNftDb();

  // Find items ready to retry
  const now = new Date().toISOString();
  const items = db
    .prepare(
      `SELECT id, mint, reason, previous_listing_price, previous_listing_at, previous_owner, attempt_count
       FROM collector_crypt_verification_queue
       WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
       LIMIT 10`,
    )
    .all(now) as Array<{
    id: string;
    mint: string;
    reason: string;
    previous_listing_price?: number;
    previous_listing_at?: string;
    previous_owner?: string;
    attempt_count: number;
  }>;

  const errors: Array<{ mint: string; error: string }> = [];
  let resolved = 0;

  for (const item of items) {
    try {
      const verification = await verifyDisappearedListing({
        mint: item.mint,
        previousListing: {
          price: item.previous_listing_price,
          listedAt: item.previous_listing_at,
          seller: item.previous_owner,
        },
        previousOwner: item.previous_owner,
      });

      const nextAttempt = item.attempt_count + 1;
      const updateNow = new Date().toISOString();

      if (nextAttempt >= MAX_ATTEMPTS || verification.result !== "unknown") {
        // Resolved or max attempts reached
        db.prepare(
          `UPDATE collector_crypt_verification_queue SET
            status = 'resolved',
            result = ?,
            result_tx_hash = ?,
            result_timestamp = ?,
            manual_review = ?,
            attempt_count = ?,
            last_attempt_at = ?,
            updated_at = ?
           WHERE id = ?`,
        ).run(
          verification.result,
          verification.txHash,
          verification.timestamp,
          verification.manualReview ? 1 : 0,
          nextAttempt,
          updateNow,
          updateNow,
          item.id,
        );

        resolved++;

        // Update listing status
        db.prepare(
          `UPDATE collector_crypt_listings SET
            listing_status = ?,
            verification_status = ?,
            verification_tx_hash = ?,
            verification_timestamp = ?,
            updated_at = ?
           WHERE mint = ? AND is_current_snapshot = 0`,
        ).run(verification.result, `verified_${verification.result}`, verification.txHash, verification.timestamp, updateNow, item.mint);

        // Create appropriate event only if verification is confident
        if (verification.result === "sold" && verification.txHash) {
          const saleEvent: RwaNftMarketEvent = {
            mint: item.mint,
            eventType: "SALE",
            priceSol: null,
            priceUsd: null,
            marketplace: "Collector Crypt",
            txSignature: verification.txHash,
            buyer: null,
            seller: null,
            owner: null,
            eventAt: verification.timestamp || updateNow,
            source: "collector-crypt-verification",
            rawPayload: { evidence: verification.evidence },
          };

          try {
            await saveRwaNftMarketEvent(saleEvent, { includeStaging: true });
          } catch (error) {
            console.error(`[Collector Crypt] Failed to save SALE event for ${item.mint}:`, error);
          }
        } else if (verification.result === "transferred" && verification.txHash) {
          const transferEvent: RwaNftMarketEvent = {
            mint: item.mint,
            eventType: "TRANSFER",
            priceSol: null,
            priceUsd: null,
            marketplace: null,
            txSignature: verification.txHash,
            buyer: null,
            seller: null,
            owner: null,
            eventAt: verification.timestamp || updateNow,
            source: "collector-crypt-verification",
            rawPayload: { evidence: verification.evidence },
          };

          try {
            await saveRwaNftMarketEvent(transferEvent, { includeStaging: true });
          } catch (error) {
            console.error(`[Collector Crypt] Failed to save TRANSFER event for ${item.mint}:`, error);
          }
        } else if (verification.result === "delisted") {
          const delistEvent: RwaNftMarketEvent = {
            mint: item.mint,
            eventType: "DELISTED",
            priceSol: null,
            priceUsd: null,
            marketplace: "Collector Crypt",
            txSignature: null,
            buyer: null,
            seller: null,
            owner: null,
            eventAt: updateNow,
            source: "collector-crypt-verification",
            rawPayload: { evidence: verification.evidence },
          };

          try {
            await saveRwaNftMarketEvent(delistEvent, { includeStaging: true });
          } catch (error) {
            console.error(`[Collector Crypt] Failed to save DELISTED event for ${item.mint}:`, error);
          }
        }
      } else {
        // Need another retry
        const nextRetryDelay = RETRY_DELAYS[nextAttempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        const nextRetryAt = new Date(Date.now() + nextRetryDelay).toISOString();

        db.prepare(
          `UPDATE collector_crypt_verification_queue SET
            attempt_count = ?,
            last_attempt_at = ?,
            next_retry_at = ?,
            updated_at = ?
           WHERE id = ?`,
        ).run(nextAttempt, updateNow, nextRetryAt, updateNow, item.id);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "unknown error";
      errors.push({ mint: item.mint, error: errorMsg });

      const nextAttempt = item.attempt_count + 1;
      const updateNow = new Date().toISOString();

      if (nextAttempt >= MAX_ATTEMPTS) {
        // Max attempts: mark as unknown with manual review
        db.prepare(
          `UPDATE collector_crypt_verification_queue SET
            status = 'resolved',
            result = 'unknown',
            manual_review = 1,
            attempt_count = ?,
            last_attempt_at = ?,
            updated_at = ?
           WHERE id = ?`,
        ).run(nextAttempt, updateNow, updateNow, item.id);

        resolved++;
      } else {
        // Schedule next retry
        const nextRetryDelay = RETRY_DELAYS[nextAttempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        const nextRetryAt = new Date(Date.now() + nextRetryDelay).toISOString();

        db.prepare(
          `UPDATE collector_crypt_verification_queue SET
            attempt_count = ?,
            last_attempt_at = ?,
            next_retry_at = ?,
            updated_at = ?
           WHERE id = ?`,
        ).run(nextAttempt, updateNow, nextRetryAt, updateNow, item.id);
      }
    }
  }

  // Count remaining queued items
  const queuedResult = db
    .prepare("SELECT COUNT(*) as count FROM collector_crypt_verification_queue WHERE status = 'pending'")
    .get() as { count: number };

  return {
    processed: items.length,
    resolved,
    queued: queuedResult.count,
    errors,
  };
}
