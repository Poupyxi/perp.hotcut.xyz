import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/providers/status")({
  server: {
    handlers: {
      GET: async () => {
        const { getProviderStatusReport } = await import("@/lib/provider-ingestion/ingest");
        const { getMarketActivityProviderStatusReport } = await import("@/services/nftMarketActivityConnectors");
        const salesProviders = await getProviderStatusReport();
        return Response.json(
          {
            ...salesProviders,
            ...getMarketActivityProviderStatusReport(),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    },
  },
});
