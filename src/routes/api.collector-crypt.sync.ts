import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/collector-crypt/sync")({
  server: {
    handlers: {
      POST: async () => {
        try {
          const { syncCollectorCryptListings } = await import("@/jobs/syncCollectorCryptListings");
          const result = await syncCollectorCryptListings();
          return Response.json(result, {
            headers: { "Cache-Control": "no-store" },
          });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Failed to sync Collector Crypt listings" },
            { status: 400 },
          );
        }
      },
    },
  },
});
