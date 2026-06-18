import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  verifyDisappearedListing,
  processCollectorCryptVerificationQueue,
} from "../collectorCryptVerificationService";

// Mock Helius responses
const mockGetHeliusAsset = vi.fn();
const mockGetHeliusSignaturesForAsset = vi.fn();
const mockGetHeliusTransaction = vi.fn();

vi.mock("../heliusRpcClient", () => ({
  getHeliusAsset: (mint: string) => mockGetHeliusAsset(mint),
  getHeliusSignaturesForAsset: (mint: string) => mockGetHeliusSignaturesForAsset(mint),
  getHeliusTransaction: (signature: string) => mockGetHeliusTransaction(signature),
}));

describe("Collector Crypt Verification - Payment Scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Valid SOL Sale", () => {
    it("should classify as SOLD when owner changed + NFT transfer + SOL payment", async () => {
      const mint = "So11111111111111111111111111111111111111112"; // Example mint
      const seller = "SellerWallet111111111111111111111111111111";
      const buyer = "BuyerWallet1111111111111111111111111111111";

      // Mock: owner changed (current owner is buyer)
      mockGetHeliusAsset.mockResolvedValue({
        error: null,
        asset: {
          ownership: { owner: buyer },
          state: "confirmed",
        },
      });

      // Mock: recent signatures (one SOL payment transaction)
      mockGetHeliusSignaturesForAsset.mockResolvedValue({
        error: null,
        signatures: ["txhash1234567890abcdef1234567890abcdef12345678"],
      });

      // Mock: transaction with NFT transfer + SOL payment
      mockGetHeliusTransaction.mockResolvedValue({
        error: null,
        tx: {
          signature: "txhash1234567890abcdef1234567890abcdef12345678",
          blockTime: 1700000000,
          preBalances: [1000000000, 2000000000, 3000000000], // Seller: 2 SOL
          postBalances: [999999000, 3000000000, 2000999000], // Seller received ~1 SOL
          instructions: [
            {
              programId: "TokenkegQfeZyiNwAJsyFbPVwwQQQccqEqwxZStobc1XC",
              accounts: [seller, buyer, "NFTMint", "NFTMeta"],
              data: "transfer_instruction",
            },
          ],
          meta: {
            preTokenBalances: [],
            postTokenBalances: [],
          },
        },
      });

      const result = await verifyDisappearedListing({
        mint,
        previousListing: {
          price: 1.0,
          listedAt: new Date().toISOString(),
          seller,
        },
      });

      expect(result.result).toBe("sold");
      expect(result.txHash).toBe("txhash1234567890abcdef1234567890abcdef12345678");
      expect(result.manualReview).toBe(false);
      expect(result.evidence.some((e) => e.includes("SOL payment"))).toBe(true);
    });
  });

  describe("Valid USDC Sale", () => {
    it("should classify as SOLD when owner changed + NFT transfer + USDC payment", async () => {
      const mint = "So11111111111111111111111111111111111111112";
      const seller = "SellerWallet111111111111111111111111111111";
      const buyer = "BuyerWallet1111111111111111111111111111111";
      const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

      mockGetHeliusAsset.mockResolvedValue({
        error: null,
        asset: {
          ownership: { owner: buyer },
          state: "confirmed",
        },
      });

      mockGetHeliusSignaturesForAsset.mockResolvedValue({
        error: null,
        signatures: ["txhash2234567890abcdef1234567890abcdef12345678"],
      });

      // Transaction with NFT transfer + USDC payment (token balance change)
      mockGetHeliusTransaction.mockResolvedValue({
        error: null,
        tx: {
          signature: "txhash2234567890abcdef1234567890abcdef12345678",
          blockTime: 1700000000,
          preBalances: [1000000000],
          postBalances: [999999000],
          instructions: [
            {
              programId: "TokenkegQfeZyiNwAJsyFbPVwwQQQccqEqwxZStobc1XC",
              accounts: [seller, buyer, USDC_MINT],
              data: "transfer_checked",
            },
          ],
          meta: {
            preTokenBalances: [
              {
                accountIndex: 1,
                mint: USDC_MINT,
                uiTokenAmount: { amount: "0", decimals: 6 },
              },
            ],
            postTokenBalances: [
              {
                accountIndex: 1,
                mint: USDC_MINT,
                uiTokenAmount: { amount: "100000000", decimals: 6 }, // 100 USDC
              },
            ],
          },
        },
      });

      const result = await verifyDisappearedListing({
        mint,
        previousListing: {
          price: 100.0,
          listedAt: new Date().toISOString(),
          seller,
        },
      });

      expect(result.result).toBe("sold");
      expect(result.txHash).toBe("txhash2234567890abcdef1234567890abcdef12345678");
      expect(result.manualReview).toBe(false);
      expect(result.evidence.some((e) => e.includes("USDC payment"))).toBe(true);
    });
  });

  describe("Unrelated SOL Transfer", () => {
    it("should not classify as SOLD when SOL transfer exists but no NFT transfer", async () => {
      const mint = "So11111111111111111111111111111111111111112";
      const seller = "SellerWallet111111111111111111111111111111";
      const buyer = "BuyerWallet1111111111111111111111111111111";

      mockGetHeliusAsset.mockResolvedValue({
        error: null,
        asset: {
          ownership: { owner: buyer },
          state: "confirmed",
        },
      });

      mockGetHeliusSignaturesForAsset.mockResolvedValue({
        error: null,
        signatures: ["txhash3234567890abcdef1234567890abcdef12345678"],
      });

      // Transaction with SOL payment but NO NFT transfer instruction
      mockGetHeliusTransaction.mockResolvedValue({
        error: null,
        tx: {
          signature: "txhash3234567890abcdef1234567890abcdef12345678",
          blockTime: 1700000000,
          preBalances: [1000000000, 2000000000],
          postBalances: [999999000, 2000999000], // Recipient got ~1 SOL
          instructions: [
            {
              programId: "System11111111111111111111111111111111111112", // System program, not token
              accounts: ["payer", "recipient"],
              data: "transfer",
            },
          ],
          meta: {
            preTokenBalances: [],
            postTokenBalances: [],
          },
        },
      });

      const result = await verifyDisappearedListing({
        mint,
        previousListing: {
          price: 1.0,
          listedAt: new Date().toISOString(),
          seller,
        },
      });

      expect(result.result).toBe("transferred");
      expect(result.manualReview).toBe(false);
      expect(result.evidence.some((e) => e.includes("TRANSFERRED"))).toBe(true);
    });
  });

  describe("Fee-Only Transaction", () => {
    it("should not classify as SOLD for fee-only transactions (no real payment)", async () => {
      const mint = "So11111111111111111111111111111111111111112";
      const seller = "SellerWallet111111111111111111111111111111";
      const buyer = "BuyerWallet1111111111111111111111111111111";

      mockGetHeliusAsset.mockResolvedValue({
        error: null,
        asset: {
          ownership: { owner: buyer },
          state: "confirmed",
        },
      });

      mockGetHeliusSignaturesForAsset.mockResolvedValue({
        error: null,
        signatures: ["txhash4234567890abcdef1234567890abcdef12345678"],
      });

      // Transaction with NFT transfer but only fees/rent, no payment to recipient
      mockGetHeliusTransaction.mockResolvedValue({
        error: null,
        tx: {
          signature: "txhash4234567890abcdef1234567890abcdef12345678",
          blockTime: 1700000000,
          preBalances: [1000000000, 2000000000, 3000000000],
          postBalances: [999995000, 2000000000, 3000005000], // Only rent adjustments, no significant transfer
          instructions: [
            {
              programId: "TokenkegQfeZyiNwAJsyFbPVwwQQQccqEqwxZStobc1XC",
              accounts: [seller, buyer, "NFTMint"],
              data: "transfer",
            },
          ],
          meta: {
            preTokenBalances: [],
            postTokenBalances: [],
          },
        },
      });

      const result = await verifyDisappearedListing({
        mint,
        previousListing: {
          price: 1.0,
          listedAt: new Date().toISOString(),
          seller,
        },
      });

      expect(result.result).toBe("transferred");
      expect(result.manualReview).toBe(false);
      expect(result.evidence.some((e) => e.includes("TRANSFERRED"))).toBe(true);
    });
  });

  describe("Owner Unchanged Without Cancellation Evidence", () => {
    it("should classify as UNKNOWN when owner unchanged + no explicit delisting evidence", async () => {
      const mint = "So11111111111111111111111111111111111111112";
      const owner = "OwnerWallet1111111111111111111111111111111";

      mockGetHeliusAsset.mockResolvedValue({
        error: null,
        asset: {
          ownership: { owner }, // Same owner
          state: "confirmed",
        },
      });

      mockGetHeliusSignaturesForAsset.mockResolvedValue({
        error: null,
        signatures: ["txhash5234567890abcdef1234567890abcdef12345678"],
      });

      // Recent transaction but no cancellation evidence
      mockGetHeliusTransaction.mockResolvedValue({
        error: null,
        tx: {
          signature: "txhash5234567890abcdef1234567890abcdef12345678",
          blockTime: 1700000000,
          preBalances: [1000000000],
          postBalances: [999999000],
          instructions: [
            {
              programId: "System11111111111111111111111111111111111112",
              accounts: ["someAccount"],
              data: "generic_instruction",
            },
          ],
          meta: {
            log: ["Program log: Some activity"],
            preTokenBalances: [],
            postTokenBalances: [],
          },
        },
      });

      const result = await verifyDisappearedListing({
        mint,
        previousListing: {
          price: 1.0,
          listedAt: new Date().toISOString(),
          seller: owner,
        },
      });

      expect(result.result).toBe("unknown");
      expect(result.manualReview).toBe(true);
      expect(result.evidence.some((e) => e.includes("no explicit cancellation evidence"))).toBe(true);
    });
  });

  describe("Explicit Delisting Transaction", () => {
    it("should classify as DELISTED when owner unchanged + explicit cancellation evidence", async () => {
      const mint = "So11111111111111111111111111111111111111112";
      const owner = "OwnerWallet1111111111111111111111111111111";

      mockGetHeliusAsset.mockResolvedValue({
        error: null,
        asset: {
          ownership: { owner }, // Same owner
          state: "confirmed",
        },
      });

      mockGetHeliusSignaturesForAsset.mockResolvedValue({
        error: null,
        signatures: ["txhash6234567890abcdef1234567890abcdef12345678"],
      });

      // Transaction with explicit delisting evidence in logs
      mockGetHeliusTransaction.mockResolvedValue({
        error: null,
        tx: {
          signature: "txhash6234567890abcdef1234567890abcdef12345678",
          blockTime: 1700000000,
          preBalances: [1000000000],
          postBalances: [999999000],
          instructions: [
            {
              programId: "TokenkegQfeZyiNwAJsyFbPVwwQQQccqEqwxZStobc1XC",
              accounts: ["listing", "owner"],
              data: "cancel_listing",
            },
          ],
          meta: {
            log: [
              "Program log: Listing canceled",
              "Program log: Event: ListingCanceled { listing: ... }",
            ],
            preTokenBalances: [],
            postTokenBalances: [],
          },
        },
      });

      const result = await verifyDisappearedListing({
        mint,
        previousListing: {
          price: 1.0,
          listedAt: new Date().toISOString(),
          seller: owner,
        },
      });

      expect(result.result).toBe("delisted");
      expect(result.txHash).toBe("txhash6234567890abcdef1234567890abcdef12345678");
      expect(result.manualReview).toBe(false);
      expect(result.evidence.some((e) => e.includes("Explicit"))).toBe(true);
    });
  });
});
