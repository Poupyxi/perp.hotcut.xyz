import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

let cachedConnection: Connection | null = null;
let cachedServerKeypair: Keypair | null = null;

function env(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

export function rpcUrl(): string {
  return env().SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";
}

export function getConnection(): Connection {
  if (cachedConnection) return cachedConnection;
  cachedConnection = new Connection(rpcUrl(), "confirmed");
  return cachedConnection;
}

export function getServerKeypair(): Keypair {
  if (cachedServerKeypair) return cachedServerKeypair;
  const secret = env().SERVER_WALLET_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "SERVER_WALLET_SECRET missing. Run: docker exec perp-frontend sh -c 'cd /app && npx tsx scripts/gacha-init-wallet.ts'",
    );
  }
  cachedServerKeypair = Keypair.fromSecretKey(bs58.decode(secret));
  return cachedServerKeypair;
}

export function serverWalletAddress(): string {
  return getServerKeypair().publicKey.toBase58();
}

export type PaymentVerification = {
  ok: boolean;
  reason: string | null;
  signature: string;
};

/**
 * Verify that `signature` is a SystemProgram transfer of `expectedLamports`
 * from `expectedFrom` to the server wallet. Server-side authoritative check.
 */
export async function verifyPaymentTransfer(input: {
  signature: string;
  expectedFrom: string;
  expectedLamports: number;
}): Promise<PaymentVerification> {
  const conn = getConnection();
  try {
    const tx = await conn.getParsedTransaction(input.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) return { ok: false, reason: "Transaction not found yet (try again in a sec)", signature: input.signature };
    if (tx.meta?.err) return { ok: false, reason: `Transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`, signature: input.signature };

    const serverWallet = serverWalletAddress();
    const instructions = tx.transaction.message.instructions;
    for (const ix of instructions) {
      if ("parsed" in ix && ix.parsed?.type === "transfer" && ix.program === "system") {
        const info = ix.parsed.info as { source: string; destination: string; lamports: number };
        if (info.destination === serverWallet && info.source === input.expectedFrom) {
          if (info.lamports >= input.expectedLamports) {
            return { ok: true, reason: null, signature: input.signature };
          }
          return {
            ok: false,
            reason: `Underpayment: expected ${input.expectedLamports} lamports, got ${info.lamports}`,
            signature: input.signature,
          };
        }
      }
    }
    return { ok: false, reason: "No matching SystemProgram.transfer found in tx", signature: input.signature };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "verifyPaymentTransfer error", signature: input.signature };
  }
}

export function solToLamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL);
}

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

export function isValidPublicKey(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}
