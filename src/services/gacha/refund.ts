import {
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getConnection, getServerKeypair, solToLamports } from "./solana";

export type RefundResult = { signature: string; lamports: number };

export async function refundPlayer(input: {
  playerWallet: string;
  amountSol: number;
}): Promise<RefundResult> {
  const lamports = solToLamports(input.amountSol);
  if (lamports <= 0) throw new Error("Refund amount must be > 0");

  const conn = getConnection();
  const server = getServerKeypair();
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: server.publicKey,
      toPubkey: new PublicKey(input.playerWallet),
      lamports,
    }),
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [server], { commitment: "confirmed" });
  return { signature: sig, lamports };
}
