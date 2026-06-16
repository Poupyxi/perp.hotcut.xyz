import { createFileRoute } from "@tanstack/react-router";

function isHoldDisplayStatus(nft: Record<string, unknown>) {
  const currentState = typeof nft.currentState === "string" ? nft.currentState : typeof nft.currentStatus === "string" ? nft.currentStatus : "unknown";
  const isListed = nft.isListed === true;
  const lastActivityType = typeof nft.lastActivityType === "string" ? nft.lastActivityType : null;
  const lastActivityAt = typeof nft.lastActivityAt === "string" ? nft.lastActivityAt : null;

  if (currentState === "listed" || isListed) return false;
  if (lastActivityType !== "delisted" || !lastActivityAt) return false;
  const activityAt = Date.parse(lastActivityAt);
  if (!Number.isFinite(activityAt)) return false;
  return Date.now() - activityAt >= 30 * 60 * 1000;
}

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
            nft: {
              ...result.nft,
              currentStatus: isHoldDisplayStatus(result.nft as Record<string, unknown>)
                ? "hold"
                : (typeof result.nft.currentStatus === "string" ? result.nft.currentStatus : result.nft.currentState),
            },
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
