/**
 * Detects SPL token and Token-2022 payments in transactions
 * Supports: USDC, USDT, USDN and other known payment mints
 */

// Known payment token mints on mainnet
const PAYMENT_TOKEN_MINTS = new Set([
  "EPjFWaLb3odcccccccccccccccccccccccccccccccc", // USDC (canonical)
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BcJer", // USDT
  "CDJWUqTcYTVAKXAVXoQB6A1JvUxt5d858Ux6YSMz7MS", // USDN
  "SRMuApVgqbCV9b9FYkwG3mua5VwLABJytFHUtwNr5LN", // SRM
  "So11111111111111111111111111111111111111111", // Wrapped SOL (if sent as SPL)
]);

export interface TokenTransfer {
  mint: string;
  symbol?: string;
  decimals?: number;
  amount: number;
  source: string;
  destination: string;
}

export interface PaymentEvidence {
  hasSolPayment: boolean;
  solAmount: number;
  hasTokenPayment: boolean;
  tokenPayments: TokenTransfer[];
  totalUsdValueEstimate?: number;
}

export function detectTokenTransfers(tx: unknown): TokenTransfer[] {
  if (!tx || typeof tx !== "object") return [];

  const txObj = tx as Record<string, unknown>;
  const transfers: TokenTransfer[] = [];

  // Check tokenTransfers field (from various APIs)
  const tokenTransfers = txObj.tokenTransfers;
  if (Array.isArray(tokenTransfers)) {
    for (const transfer of tokenTransfers) {
      if (!transfer || typeof transfer !== "object") continue;

      const t = transfer as Record<string, unknown>;
      const mint = String(t.mint || t.tokenMint || "").trim();
      const amount = typeof t.tokenAmount === "object"
        ? (t.tokenAmount as Record<string, unknown>).amount
        : typeof t.amount === "number"
          ? t.amount
          : 0;

      if (mint && amount > 0) {
        transfers.push({
          mint,
          symbol: String(t.symbol || "").trim() || undefined,
          decimals: typeof t.decimals === "number" ? t.decimals : undefined,
          amount: typeof amount === "string" ? parseFloat(amount) : amount,
          source: String(t.fromUserAccount || t.source || "").trim(),
          destination: String(t.toUserAccount || t.destination || "").trim(),
        });
      }
    }
  }

  // Also check instructions for programmatic transfers (less reliable but useful)
  const instructions = txObj.instructions;
  if (Array.isArray(instructions)) {
    for (const instr of instructions) {
      if (!instr || typeof instr !== "object") continue;

      const i = instr as Record<string, unknown>;
      const programId = String(i.programId || "").trim();

      // Token Program (splToken.Token)
      if (
        programId === "TokenkegQfeZyiNwAJsyFbPVwwQQfuCS3nYZR5rS7LM" ||
        programId === "TokenzQdBbjFD8aff3aLMBQaZeozVow33PQQXcLyMa"
      ) {
        // This is a token transfer, but we'd need to parse instruction data
        // Skip for now; rely on tokenTransfers field
      }
    }
  }

  return transfers;
}

export function detectNativeTransfers(tx: unknown): { amount: number; count: number } {
  if (!tx || typeof tx !== "object") return { amount: 0, count: 0 };

  const txObj = tx as Record<string, unknown>;
  let totalAmount = 0;
  let count = 0;

  // Check nativeTransfers field
  const nativeTransfers = txObj.nativeTransfers;
  if (Array.isArray(nativeTransfers)) {
    for (const transfer of nativeTransfers) {
      if (!transfer || typeof transfer !== "object") continue;

      const t = transfer as Record<string, unknown>;
      const lamports = typeof t.lamports === "number" ? t.lamports : 0;

      if (lamports > 0) {
        totalAmount += lamports;
        count++;
      }
    }
  }

  return { amount: totalAmount, count };
}

export function analyzePaymentEvidence(tx: unknown): PaymentEvidence {
  const nativePayment = detectNativeTransfers(tx);
  const tokenTransfers = detectTokenTransfers(tx);

  const hasTokenPayment = tokenTransfers.filter((t) => PAYMENT_TOKEN_MINTS.has(t.mint)).length > 0;

  return {
    hasSolPayment: nativePayment.amount > 0,
    solAmount: nativePayment.amount,
    hasTokenPayment,
    tokenPayments: tokenTransfers,
    totalUsdValueEstimate: undefined, // Could estimate from coingecko in future
  };
}

export function hasPaymentEvidence(tx: unknown): boolean {
  const evidence = analyzePaymentEvidence(tx);
  return evidence.hasSolPayment || evidence.hasTokenPayment;
}
