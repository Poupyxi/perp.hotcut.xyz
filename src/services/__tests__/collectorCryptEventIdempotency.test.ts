import { describe, it, expect } from "vitest";
import type { RwaNftMarketEvent } from "@/types/rwaNftMarket";

/**
 * Event deduplication tests
 * Key: event_type + mint + txHash
 */

describe("Event Deduplication - Idempotency", () => {
  function eventKey(event: RwaNftMarketEvent): string {
    return `${event.eventType}:${event.mint}:${event.txSignature || ""}`;
  }

  describe("SALE Event Deduplication", () => {
    it("should identify duplicate SALE events by type + mint + txHash", () => {
      const event1: RwaNftMarketEvent = {
        mint: "So11111111111111111111111111111111111111112",
        category: null,
        eventType: "SALE",
        priceSol: null,
        priceUsd: null,
        paymentMint: "SOL",
        paymentSymbol: "SOL",
        paymentAmount: 1.5,
        marketplace: "Collector Crypt",
        txSignature: "txhash1234567890abcdef",
        buyer: null,
        seller: null,
        owner: null,
        eventAt: new Date().toISOString(),
        source: "collector-crypt-verification",
        rawPayload: {},
      };

      const event2: RwaNftMarketEvent = {
        ...event1,
        // Same key data, different payload (e.g., retried processing)
        rawPayload: { evidence: ["different evidence"] },
      };

      const key1 = eventKey(event1);
      const key2 = eventKey(event2);

      expect(key1).toBe(key2); // Same event, should deduplicate
    });

    it("should NOT deduplicate SALE events with different txHash", () => {
      const event1: RwaNftMarketEvent = {
        mint: "So11111111111111111111111111111111111111112",
        category: null,
        eventType: "SALE",
        priceSol: null,
        priceUsd: null,
        paymentMint: "SOL",
        paymentSymbol: "SOL",
        paymentAmount: 1.5,
        marketplace: "Collector Crypt",
        txSignature: "txhash1111111111111111",
        buyer: null,
        seller: null,
        owner: null,
        eventAt: new Date().toISOString(),
        source: "collector-crypt-verification",
        rawPayload: {},
      };

      const event2: RwaNftMarketEvent = {
        ...event1,
        txSignature: "txhash2222222222222222", // Different transaction
      };

      const key1 = eventKey(event1);
      const key2 = eventKey(event2);

      expect(key1).not.toBe(key2); // Different txHash, different events
    });
  });

  describe("TRANSFER Event Deduplication", () => {
    it("should identify duplicate TRANSFER events by type + mint + txHash", () => {
      const event1: RwaNftMarketEvent = {
        mint: "So11111111111111111111111111111111111111112",
        category: null,
        eventType: "TRANSFER",
        priceSol: null,
        priceUsd: null,
        marketplace: null,
        txSignature: "txhash3333333333333333",
        buyer: null,
        seller: null,
        owner: null,
        eventAt: new Date().toISOString(),
        source: "collector-crypt-verification",
        rawPayload: {},
      };

      const event2: RwaNftMarketEvent = {
        ...event1,
        // Same TRANSFER, just retried
        rawPayload: { evidence: ["retry evidence"] },
      };

      const key1 = eventKey(event1);
      const key2 = eventKey(event2);

      expect(key1).toBe(key2);
    });
  });

  describe("DELISTED Event Deduplication", () => {
    it("should identify duplicate DELISTED events by type + mint + txHash", () => {
      const event1: RwaNftMarketEvent = {
        mint: "So11111111111111111111111111111111111111112",
        category: null,
        eventType: "DELISTED",
        priceSol: null,
        priceUsd: null,
        marketplace: "Collector Crypt",
        txSignature: "txhash4444444444444444", // Cancellation tx
        buyer: null,
        seller: null,
        owner: null,
        eventAt: new Date().toISOString(),
        source: "collector-crypt-verification",
        rawPayload: {},
      };

      const event2: RwaNftMarketEvent = {
        ...event1,
        // Same DELISTED with cancellation evidence, retried
        rawPayload: { evidence: ["explicit cancellation found"] },
      };

      const key1 = eventKey(event1);
      const key2 = eventKey(event2);

      expect(key1).toBe(key2);
    });
  });

  describe("Cross-Event Deduplication", () => {
    it("should NOT deduplicate SALE and TRANSFER of same mint/tx (different event types)", () => {
      const saleEvent: RwaNftMarketEvent = {
        mint: "So11111111111111111111111111111111111111112",
        category: null,
        eventType: "SALE",
        priceSol: null,
        priceUsd: null,
        marketplace: "Collector Crypt",
        txSignature: "txhash5555555555555555",
        buyer: null,
        seller: null,
        owner: null,
        eventAt: new Date().toISOString(),
        source: "collector-crypt-verification",
        rawPayload: {},
      };

      const transferEvent: RwaNftMarketEvent = {
        ...saleEvent,
        eventType: "TRANSFER", // Different event type
      };

      const saleKey = eventKey(saleEvent);
      const transferKey = eventKey(transferEvent);

      expect(saleKey).not.toBe(transferKey); // Different event types, should NOT deduplicate
    });

    it("should NOT deduplicate events for same type but different mints", () => {
      const event1: RwaNftMarketEvent = {
        mint: "So11111111111111111111111111111111111111112",
        category: null,
        eventType: "SALE",
        priceSol: null,
        priceUsd: null,
        marketplace: "Collector Crypt",
        txSignature: "txhash6666666666666666",
        buyer: null,
        seller: null,
        owner: null,
        eventAt: new Date().toISOString(),
        source: "collector-crypt-verification",
        rawPayload: {},
      };

      const event2: RwaNftMarketEvent = {
        ...event1,
        mint: "So77777777777777777777777777777777777777777", // Different mint
      };

      const key1 = eventKey(event1);
      const key2 = eventKey(event2);

      expect(key1).not.toBe(key2); // Different mints, different events
    });
  });

  describe("Queue Item Idempotency", () => {
    it("should use provider + listing_id as queue identity (not mint)", () => {
      const queueItem1 = {
        provider: "collector-crypt",
        listingId: "listing-123",
        mint: "So11111111111111111111111111111111111111112",
      };

      const queueItem2 = {
        provider: "collector-crypt",
        listingId: "listing-123",
        mint: "So11111111111111111111111111111111111111112",
      };

      const queueItem3 = {
        provider: "collector-crypt",
        listingId: "listing-456", // Different listing_id
        mint: "So11111111111111111111111111111111111111112",
      };

      function queueKey(item: { provider: string; listingId: string }): string {
        return `${item.provider}:${item.listingId}`;
      }

      expect(queueKey(queueItem1)).toBe(queueKey(queueItem2));
      expect(queueKey(queueItem1)).not.toBe(queueKey(queueItem3));
    });

    it("should allow same mint with different listing_ids to queue separately", () => {
      // Same NFT can be listed on multiple marketplaces or with multiple listing IDs
      const queue1 = {
        provider: "collector-crypt",
        listingId: "cc-listing-a",
        mint: "So11111111111111111111111111111111111111112",
      };

      const queue2 = {
        provider: "collector-crypt",
        listingId: "cc-listing-b",
        mint: "So11111111111111111111111111111111111111112", // Same mint
      };

      function queueKey(item: { provider: string; listingId: string }): string {
        return `${item.provider}:${item.listingId}`;
      }

      // Both should queue (different listing_ids)
      expect(queueKey(queue1)).not.toBe(queueKey(queue2));
    });
  });
});
