import type { RwaNftMarketEvent } from "@/types/rwaNftMarket";
import { getNftDb } from "./nftSqliteDb";
import { fetchWithHeliusKey, hasHeliusApiKey } from "./heliusApiKeyRotation";
import { saveRwaNftMarketEvent } from "./rwaNftMarketEventService";

export type VerificationResult = "sold" | "transferred" | "delisted" | "unknown";

export interface DisappearedListingVerification {
  result: VerificationResult;
  txHash: string | null;
  timestamp: string | null;
  evidence: string[];
  ownerChanged: boolean;
  hasTransfer: boolean;
  hasPayment: boolean;
}

interface HeliusAsset {
  id: string;
  ownership?: {
    owner: string;
    delegated: boolean;
    frozen: boolean;
  };
}

interface HeliusTransaction {
  signature: string;
  type?: string;
  timestamp?: number;
  nativeTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; lamports: number }>;
  tokenTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; tokenAmount?: { decimals: number; amount?: string } }>;
  instructions?: Array<{
    programId?: string;
    data?: string;
    accounts?: string[];
  }>;
}

interface HeliusSignaturesResponse {
  result: Array<{
    signature: string;
    blockTime?: number;
    err?: string | null;
  }>;
}

interface HeliusEnhancedTransactionResponse {
  result?: Array<{
    signature: string;
    type?: string;
    timestamp?: number;
    nativeTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; lamports: number }>;
    tokenTransfers?: Array<{ fromUserAccount: string; toUserAccount: string }>;
    [key: string]: unknown;
  }>;
}

const RETRY_DELAYS = [0, 30_000, 120_000]; // immediate, 30s, 2min
const MAX_ATTEMPTS = 3;

async function getHeliusOwner(mint: string): Promise<{ owner: string | null; error?: string }> {
  if (!hasHeliusApiKey()) return { owner: null, error: "No Helius API key available" };

  try {
    const response = await fetchWithHeliusKey({
      label: "collector-crypt-owner-check",
      endpoint: "https://mainnet-core.helius-rpc.com/",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "helius-owner-check",
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
      return { owner: null, error: data.error.message };
    }

    return {
      owner: data.result?.ownership?.owner || null,
    };
  } catch (error) {
    return { owner: null, error: error instanceof Error ? error.message : "Network error" };
  }
}

async function getHeliusRecentActivity(mint: string): Promise<{
  signatures: string[];
  error?: string;
}> {
  if (!hasHeliusApiKey()) return { signatures: [], error: "No Helius API key available" };

  try {
    const response = await fetchWithHeliusKey({
      label: "collector-crypt-signatures",
      endpoint: "https://mainnet-core.helius-rpc.com/",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "helius-signatures",
          method: "getSignaturesForAsset",
          params: {
            id: mint,
            limit: 10,
          },
        }),
      },
    });

    const data = (await response.json()) as HeliusSignaturesResponse | { error?: { message: string } };

    if ("error" in data && data.error) {
      return { signatures: [], error: data.error.message };
    }

    const result = (data as HeliusSignaturesResponse).result;
    const signatures = (result || []).filter((tx) => tx.err === null).map((tx) => tx.signature);
    return { signatures };
  } catch (error) {
    return { signatures: [], error: error instanceof Error ? error.message : "Network error" };
  }
}

async function getEnhancedTransactions(signatures: string[]): Promise<{
  transactions: Array<{ signature: string; data: unknown }>;
  error?: string;
}> {
  if (signatures.length === 0) {
    return { transactions: [] };
  }

  if (!hasHeliusApiKey()) return { transactions: [], error: "No Helius API key available" };

  try {
    const response = await fetchWithHeliusKey({
      label: "collector-crypt-enhanced-tx",
      endpoint: "https://api.helius.xyz/v0/transactions",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transactions: signatures.slice(0, 10),
        }),
      },
    });

    const data = (await response.json()) as HeliusEnhancedTransactionResponse;

    if (!data.result) {
      return { transactions: [] };
    }

    return {
      transactions: data.result.map((tx) => ({
        signature: tx.signature,
        data: tx,
      })),
    };
  } catch (error) {
    return { transactions: [], error: error instanceof Error ? error.message : "Network error" };
  }
}

function analyzeTransactionForSaleIndicators(tx: unknown): {
  hasTransfer: boolean;
  hasPayment: boolean;
  transferCount: number;
  paymentCount: number;
  paymentTotal: number;
} {
  if (!tx || typeof tx !== "object") {
    return { hasTransfer: false, hasPayment: false, transferCount: 0, paymentCount: 0, paymentTotal: 0 };
  }

  const txObj = tx as Record<string, unknown>;
  let transferCount = 0;
  let paymentCount = 0;
  let paymentTotal = 0;

  // Check for native SOL transfers (payment indicators)
  if (txObj.nativeTransfers && Array.isArray(txObj.nativeTransfers)) {
    for (const transfer of txObj.nativeTransfers) {
      if (transfer && typeof transfer === "object") {
        const tr = transfer as Record<string, unknown>;
        if (typeof tr.lamports === "number" && tr.lamports > 0) {
          paymentCount++;
          paymentTotal += tr.lamports;
        }
      }
    }
  }

  // Check for token transfers (likely NFT transfer)
  if (txObj.tokenTransfers && Array.isArray(txObj.tokenTransfers)) {
    transferCount = txObj.tokenTransfers.length;
  }

  // Check transaction type hints
  const typeStr = String(txObj.type || "").toLowerCase();
  const hasMarketplaceType = typeStr.includes("sale") || typeStr.includes("marketplace") || typeStr.includes("nft");

  return {
    hasTransfer: transferCount > 0,
    hasPayment: paymentCount > 0 || paymentTotal > 0,
    transferCount,
    paymentCount,
    paymentTotal,
  };
}

export async function verifyDisappearedListing(input: {
  mint: string;
  previousListing: {
    price?: number;
    listedAt?: string;
    seller?: string;
  };
  previousOwner?: string;
}): Promise<DisappearedListingVerification> {
  const evidence: string[] = [];

  // Check current owner
  const ownerResult = await getHeliusOwner(input.mint);
  if (ownerResult.error) {
    evidence.push(`Owner check failed: ${ownerResult.error}`);
    return {
      result: "unknown",
      txHash: null,
      timestamp: null,
      evidence,
      ownerChanged: false,
      hasTransfer: false,
      hasPayment: false,
    };
  }

  const currentOwner = ownerResult.owner;
  const ownerChanged = input.previousOwner && currentOwner && input.previousOwner !== currentOwner;

  if (ownerChanged) {
    evidence.push(`Owner changed: ${input.previousOwner} → ${currentOwner}`);
  }

  // Get recent activity
  const activityResult = await getHeliusRecentActivity(input.mint);
  if (activityResult.error && activityResult.signatures.length === 0) {
    evidence.push(`Activity check failed: ${activityResult.error}`);
    if (!ownerChanged) {
      // Owner unchanged and no activity = delisted
      return {
        result: "delisted",
        txHash: null,
        timestamp: null,
        evidence,
        ownerChanged: false,
        hasTransfer: false,
        hasPayment: false,
      };
    } else {
      // Owner changed but no activity info = unknown
      return {
        result: "unknown",
        txHash: null,
        timestamp: null,
        evidence,
        ownerChanged: true,
        hasTransfer: false,
        hasPayment: false,
      };
    }
  }

  // Get enhanced transactions for analysis
  const enhancedResult = await getEnhancedTransactions(activityResult.signatures);

  if (enhancedResult.error && enhancedResult.transactions.length === 0) {
    evidence.push(`Enhanced transaction fetch failed: ${enhancedResult.error}`);
    if (!ownerChanged) {
      return {
        result: "delisted",
        txHash: null,
        timestamp: null,
        evidence,
        ownerChanged: false,
        hasTransfer: false,
        hasPayment: false,
      };
    }
  }

  // Analyze transactions for sale indicators
  let bestSaleIndicator: {
    signature: string;
    hasTransfer: boolean;
    hasPayment: boolean;
  } | null = null;
  let hasRecentActivity = false;

  for (const tx of enhancedResult.transactions) {
    const analysis = analyzeTransactionForSaleIndicators(tx.data);

    if (analysis.transferCount > 0 || analysis.paymentCount > 0) {
      hasRecentActivity = true;

      // Look for transactions with both transfer and payment (sale indicator)
      if (analysis.hasTransfer && analysis.hasPayment) {
        if (!bestSaleIndicator) {
          bestSaleIndicator = {
            signature: tx.signature,
            hasTransfer: true,
            hasPayment: true,
          };
        }
      } else if (analysis.hasTransfer && !bestSaleIndicator) {
        bestSaleIndicator = {
          signature: tx.signature,
          hasTransfer: true,
          hasPayment: analysis.hasPayment,
        };
      }
    }
  }

  // Decision logic
  if (ownerChanged) {
    if (bestSaleIndicator?.hasPayment) {
      evidence.push(`Sale indicators found: transfer + payment in ${bestSaleIndicator.signature}`);
      return {
        result: "sold",
        txHash: bestSaleIndicator.signature,
        timestamp: new Date().toISOString(),
        evidence,
        ownerChanged: true,
        hasTransfer: true,
        hasPayment: true,
      };
    } else if (bestSaleIndicator?.hasTransfer) {
      evidence.push(`Transfer detected without payment in ${bestSaleIndicator.signature}`);
      return {
        result: "transferred",
        txHash: bestSaleIndicator.signature,
        timestamp: new Date().toISOString(),
        evidence,
        ownerChanged: true,
        hasTransfer: true,
        hasPayment: false,
      };
    } else if (hasRecentActivity) {
      evidence.push("Owner changed but no transfer/payment evidence found");
      return {
        result: "unknown",
        txHash: null,
        timestamp: null,
        evidence,
        ownerChanged: true,
        hasTransfer: false,
        hasPayment: false,
      };
    } else {
      evidence.push("Owner changed but no recent activity detected");
      return {
        result: "unknown",
        txHash: null,
        timestamp: null,
        evidence,
        ownerChanged: true,
        hasTransfer: false,
        hasPayment: false,
      };
    }
  } else {
    // Owner unchanged
    evidence.push("Owner unchanged");
    if (hasRecentActivity) {
      evidence.push("Some activity detected but owner did not change");
    }
    return {
      result: "delisted",
      txHash: null,
      timestamp: null,
      evidence,
      ownerChanged: false,
      hasTransfer: false,
      hasPayment: false,
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
        // Resolved or max attempts
        db.prepare(
          `UPDATE collector_crypt_verification_queue SET
            status = 'resolved',
            result = ?,
            result_tx_hash = ?,
            result_timestamp = ?,
            attempt_count = ?,
            last_attempt_at = ?,
            updated_at = ?
           WHERE id = ?`,
        ).run(verification.result, verification.txHash, verification.timestamp, nextAttempt, updateNow, updateNow, item.id);

        resolved++;

        // Also update collector_crypt_listings with verification result
        db.prepare(
          `UPDATE collector_crypt_listings SET
            listing_status = ?,
            verification_status = ?,
            verification_tx_hash = ?,
            verification_timestamp = ?,
            updated_at = ?
           WHERE mint = ? AND is_current_snapshot = 0`,
        ).run(`${verification.result}`, `verified_${verification.result}`, verification.txHash, verification.timestamp, updateNow, item.mint);

        // If sold, create SALE event
        if (verification.result === "sold" && verification.txHash) {
          const saleEvent: RwaNftMarketEvent = {
            mint: item.mint,
            eventType: "SALE",
            priceSol: null, // DO NOT use previous_listing_price
            priceUsd: null,
            marketplace: "Collector Crypt",
            txSignature: verification.txHash,
            buyer: null, // Only set if Helius provides verified buyer
            seller: null,
            owner: null,
            eventAt: verification.timestamp || updateNow,
            source: "collector-crypt-verification",
            rawPayload: {
              reason: "listing_disappeared_helius_verified",
              evidence: verification.evidence,
            },
          };

          try {
            await saveRwaNftMarketEvent(saleEvent, { includeStaging: true });
          } catch (error) {
            console.error(`[Collector Crypt Verification] Failed to save SALE event for ${item.mint}:`, error);
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

      // Mark as failed attempt
      const nextAttempt = item.attempt_count + 1;
      const updateNow = new Date().toISOString();

      if (nextAttempt >= MAX_ATTEMPTS) {
        // Max attempts reached, mark as unknown
        db.prepare(
          `UPDATE collector_crypt_verification_queue SET
            status = 'resolved',
            result = 'unknown',
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
