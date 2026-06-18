/**
 * Detects and parses compressed NFTs (cNFTs) using Bubblegum program
 * Supports State Compression on Solana
 */

export interface CompressedNftInfo {
  isCompressed: boolean;
  treeId?: string;
  leafIndex?: number;
  owner?: string;
  delegated: boolean;
}

// Bubblegum program ID for cNFT operations
const BUBBLEGUM_PROGRAM_ID = "BGUMAp9Gq7iTEuiasb3F7f2QsGgsSnwvDL4GMZ5bXYaH";

// State Compression program (Solana Labs reference)
const STATE_COMPRESSION_PROGRAM_ID = "cmtDvXumGCjsNwoDL3BjPvxKbfqJG2vgaoxzt27rhinK";

export function isCompressedNft(asset: unknown): boolean {
  if (!asset || typeof asset !== "object") return false;

  const a = asset as Record<string, unknown>;

  // Check state field: "compressed" indicates cNFT
  const state = String(a.state || "").toLowerCase();
  if (state === "compressed") return true;

  // Alternative: check interface field
  const iface = String(a.interface || "").toLowerCase();
  if (iface.includes("compress")) return true;

  return false;
}

export function extractCompressedNftInfo(asset: unknown): CompressedNftInfo {
  if (!asset || typeof asset !== "object") {
    return { isCompressed: false, delegated: false };
  }

  const a = asset as Record<string, unknown>;
  const compressed = isCompressedNft(a);

  if (!compressed) {
    return { isCompressed: false, delegated: false };
  }

  // Extract tree ID and leaf index from compression field
  const compression = a.compression;
  let treeId: string | undefined;
  let leafIndex: number | undefined;

  if (compression && typeof compression === "object") {
    const c = compression as Record<string, unknown>;
    treeId = String(c.tree || c.treeId || "").trim() || undefined;
    leafIndex = typeof c.leaf_index === "number" ? c.leaf_index : typeof c.leafIndex === "number" ? c.leafIndex : undefined;
  }

  // Extract owner from ownership field
  let owner: string | undefined;
  const ownership = a.ownership;
  if (ownership && typeof ownership === "object") {
    const o = ownership as Record<string, unknown>;
    owner = String(o.owner || "").trim() || undefined;
  }

  return {
    isCompressed: true,
    treeId,
    leafIndex,
    owner,
    delegated: false,
  };
}

export function detectBubblegumInstruction(instruction: unknown): {
  isBubblegumOp: boolean;
  isTransfer: boolean;
  isBurn: boolean;
  isMint: boolean;
} {
  if (!instruction || typeof instruction !== "object") {
    return { isBubblegumOp: false, isTransfer: false, isBurn: false, isMint: false };
  }

  const instr = instruction as Record<string, unknown>;
  const programId = String(instr.programId || "").trim();

  if (programId !== BUBBLEGUM_PROGRAM_ID) {
    return { isBubblegumOp: false, isTransfer: false, isBurn: false, isMint: false };
  }

  // Bubblegum operations are identified by instruction data (first byte typically)
  // We'd need to decode instruction data to be precise, but we can make educated guesses
  // based on accounts and other context
  const accounts = instr.accounts;
  const accountCount = Array.isArray(accounts) ? accounts.length : 0;

  // This is simplified; real implementation would decode instruction data
  return {
    isBubblegumOp: true,
    isTransfer: accountCount >= 6, // Transfer requires leaf account, tree, etc.
    isBurn: accountCount >= 5, // Burn also modifies tree
    isMint: accountCount >= 4, // Mint creates new leaf
  };
}

export function detectNftTransferInBubblegum(tx: unknown): {
  hasTransfer: boolean;
  fromAccount?: string;
  toAccount?: string;
} {
  if (!tx || typeof tx !== "object") {
    return { hasTransfer: false };
  }

  const txObj = tx as Record<string, unknown>;
  const instructions = txObj.instructions;

  if (!Array.isArray(instructions)) {
    return { hasTransfer: false };
  }

  // Look for Bubblegum transfer instructions
  for (const instr of instructions) {
    if (!instr || typeof instr !== "object") continue;

    const detection = detectBubblegumInstruction(instr);
    if (detection.isBubblegumOp && detection.isTransfer) {
      const i = instr as Record<string, unknown>;
      const accounts = i.accounts;

      if (Array.isArray(accounts) && accounts.length >= 2) {
        return {
          hasTransfer: true,
          fromAccount: String(accounts[0] || "").trim() || undefined,
          toAccount: String(accounts[1] || "").trim() || undefined,
        };
      }
    }
  }

  return { hasTransfer: false };
}

export function isCompressedNftTransfer(tx: unknown): boolean {
  const transfer = detectNftTransferInBubblegum(tx);
  return transfer.hasTransfer;
}
