import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/nfts/$assetMint/market-state")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { getNFTMarketState } = await import("@/services/nftMarketStateService");
        const state = await getNFTMarketState(params.assetMint);
        if (!state) {
          return Response.json({ error: "NFT not found in NFT List" }, { status: 404, headers: { "Cache-Control": "no-store" } });
        }

        return Response.json({ marketState: state }, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
