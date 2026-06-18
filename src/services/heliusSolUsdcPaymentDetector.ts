/**
 * Simplified payment detection: SOL and official mainnet USDC only
 * Uses raw balance changes to verify payment
 */

// Official Solana mainnet USDC mint (USDC token on Solana)
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface PaymentEvidence {
  hasSolPayment: boolean;
  solAmount: number; // in lamports
  hasUsdcPayment: boolean;
  usdcAmount: number; // in USDC units (with decimals)
  paymentDirection?: string; // "buyer to seller" or account movement
}

export interface Transaction {
  signature?: string;
  accountKeys?: Array<{ pubkey: string; signer: boolean; writable: boolean }>;
  preBalances?: number[];
  postBalances?: number[];
  meta?: {
    preTokenBalances?: Array<{
      accountIndex: number;
      mint: string;
      uiTokenAmount: {
        amount: string;
        decimals: number;
      };
    }>;
    postTokenBalances?: Array<{
      accountIndex: number;
      mint: string;
      uiTokenAmount: {
        amount: string;
        decimals: number;
      };
    }>;
  };
  [key: string]: unknown;
}

/**
 * Detect SOL payment by comparing account balance changes
 * Ignores: rent, fees, transaction costs
 */
export function detectSolPayment(tx: unknown): { found: boolean; amount: number } {
  if (!tx || typeof tx !== "object") return { found: false, amount: 0 };

  const txObj = tx as Transaction;

  if (!Array.isArray(txObj.preBalances) || !Array.isArray(txObj.postBalances)) {
    return { found: false, amount: 0 };
  }

  // Look for significant SOL transfers (excluding first account which pays fees)
  // We're looking for accounts that received SOL (postBalance > preBalance)
  let maxTransferAmount = 0;

  for (let i = 1; i < txObj.preBalances.length; i++) {
    const pre = txObj.preBalances[i] || 0;
    const post = txObj.postBalances[i] || 0;
    const difference = post - pre;

    // Payment: account received SOL (positive difference, not just rent)
    // Ignore very small amounts (< 0.001 SOL = 1,000,000 lamports)
    if (difference > 1_000_000) {
      maxTransferAmount = Math.max(maxTransferAmount, difference);
    }
  }

  return {
    found: maxTransferAmount > 0,
    amount: maxTransferAmount,
  };
}

/**
 * Detect USDC payment by comparing token balance changes
 * Official mainnet USDC only: EPjFWaLb3odcccccccccccccccccccccccccccccccc
 */
export function detectUsdcPayment(tx: unknown): { found: boolean; amount: number } {
  if (!tx || typeof tx !== "object") return { found: false, amount: 0 };

  const txObj = tx as Transaction;
  const meta = txObj.meta;

  if (!meta || typeof meta !== "object") {
    return { found: false, amount: 0 };
  }

  const m = meta as {
    preTokenBalances?: Array<{ mint: string; accountIndex: number; uiTokenAmount?: { amount: string; decimals: number } }>;
    postTokenBalances?: Array<{ mint: string; accountIndex: number; uiTokenAmount?: { amount: string; decimals: number } }>;
  };

  const preTokenBalances = m.preTokenBalances || [];
  const postTokenBalances = m.postTokenBalances || [];

  // Create maps of account index to balance for USDC
  const preUsdcMap = new Map<number, string>();
  const postUsdcMap = new Map<number, string>();

  for (const balance of preTokenBalances) {
    if (balance.mint === USDC_MINT) {
      preUsdcMap.set(balance.accountIndex, balance.uiTokenAmount?.amount || "0");
    }
  }

  for (const balance of postTokenBalances) {
    if (balance.mint === USDC_MINT) {
      postUsdcMap.set(balance.accountIndex, balance.uiTokenAmount?.amount || "0");
    }
  }

  // Find significant USDC transfers (accounts that received USDC)
  let maxTransferAmount = 0;

  for (const [accountIndex, postAmount] of postUsdcMap) {
    const preAmount = preUsdcMap.get(accountIndex) || "0";
    const difference = BigInt(postAmount) - BigInt(preAmount);

    // Payment: account received USDC (positive difference)
    // Ignore very small amounts (< 0.01 USDC = 10,000 units at 6 decimals)
    if (difference > BigInt(10_000)) {
      const amountNum = Number(difference) / 1_000_000; // Convert to USDC (6 decimals)
      maxTransferAmount = Math.max(maxTransferAmount, amountNum);
    }
  }

  return {
    found: maxTransferAmount > 0,
    amount: maxTransferAmount,
  };
}

/**
 * Analyze transaction for payment evidence
 * Only SOL and official mainnet USDC
 */
export function analyzePaymentEvidence(tx: unknown): PaymentEvidence {
  const solPayment = detectSolPayment(tx);
  const usdcPayment = detectUsdcPayment(tx);

  return {
    hasSolPayment: solPayment.found,
    solAmount: solPayment.amount,
    hasUsdcPayment: usdcPayment.found,
    usdcAmount: usdcPayment.amount,
  };
}

/**
 * Check if transaction has any valid payment evidence
 * Only SOL and official mainnet USDC count
 */
export function hasValidPaymentEvidence(tx: unknown): boolean {
  const evidence = analyzePaymentEvidence(tx);
  return evidence.hasSolPayment || evidence.hasUsdcPayment;
}
