import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/nfts/$assetMint")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const { refreshNftByMint } = await import("@/services/nftListEnrichmentService");

        const url = new URL(request.url);
        const refresh = url.searchParams.get("refresh") === "true";
        const result = await refreshNftByMint({ mint: params.assetMint, refresh, dryRun: false });

        if (!result.nft) {
          return Response.json(
            { error: result.error ?? "NFT not found or provider unavailable" },
            { status: 404, headers: { "Cache-Control": "no-store" } },
          );
        }

        return Response.json(
          {
            nft: result.nft,
            cacheHit: result.cacheHit,
            refreshed: result.heliusCalled && result.dbUpdated,
            providerUsed: result.providerUsed,
            reason: result.reason,
            verifiedSalesDetected: result.verifiedSalesDetected,
            verifiedSalesStored: result.verifiedSalesStored,
            error: result.error,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    },
  },
});
