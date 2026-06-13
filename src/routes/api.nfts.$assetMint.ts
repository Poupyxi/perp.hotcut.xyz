import { createFileRoute } from "@tanstack/react-router";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export const Route = createFileRoute("/api/nfts/$assetMint")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { getNftDb } = await import("@/services/nftSqliteDb");
        const row = getNftDb().prepare("SELECT * FROM nft_assets WHERE mint = ?").get(params.assetMint) as Record<string, unknown> | undefined;
        if (!row) return Response.json({ error: "NFT not found" }, { status: 404 });

        return Response.json({
          nft: {
            assetMint: asString(row.mint),
            assetName: asString(row.name),
            imageUrl: asString(row.image),
            market: asString(row.market),
            category: asString(row.category),
            collectionSlug: asString(row.source_collection) ?? asString(row.collection),
            collectionName: asString(row.collection_name) ?? asString(row.collection),
            assetType: asString(row.asset_type) ?? "unknown",
            ownerWallet: asString(row.owner),
            source: asString(row.source_collection),
            provider: asString(row.source_provider) ?? asString(row.latest_provider),
            currentState: asString(row.current_state) ?? asString(row.current_status) ?? "unknown",
            lastActivityType: asString(row.last_activity_type) ?? "unknown",
            lastActivityAt: asString(row.last_activity_at),
            lastActivityTxHash: asString(row.last_activity_tx_hash),
            lastActivityProvider: asString(row.last_activity_provider),
            latestListingPriceSol: typeof row.listed_price_sol === "number" ? row.listed_price_sol : null,
            latestListingPriceUsd: typeof row.listed_price_usd === "number" ? row.listed_price_usd : null,
            latestSalePriceSol: typeof row.last_sale_price_sol === "number" ? row.last_sale_price_sol : null,
            latestSalePriceUsd: typeof row.last_sale_price_usd === "number" ? row.last_sale_price_usd : null,
            latestPurchasePriceSol: typeof row.latest_purchase_price_sol === "number" ? row.latest_purchase_price_sol : null,
            latestPurchasePriceUsd: typeof row.latest_purchase_price_usd === "number" ? row.latest_purchase_price_usd : null,
            latestMarketPriceSol: typeof row.latest_market_price_sol === "number" ? row.latest_market_price_sol : null,
            latestMarketPriceUsd: typeof row.latest_market_price_usd === "number" ? row.latest_market_price_usd : null,
            latestMarketplace: asString(row.latest_marketplace),
            latestProvider: asString(row.latest_provider),
            latestTxHash: asString(row.latest_tx_hash),
            lastCheckedAt: asString(row.last_checked_at),
            metadataStatus: asString(row.metadata_status) ?? "missing",
            validationStatus: asString(row.validation_status) ?? "unverified",
          },
        }, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
