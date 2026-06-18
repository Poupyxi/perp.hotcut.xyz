import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/collector-crypt/verify")({
  server: {
    handlers: {
      POST: async () => {
        try {
          const { processCollectorCryptVerification } = await import("@/jobs/processCollectorCryptVerification");
          const result = await processCollectorCryptVerification();
          return Response.json(result, {
            headers: { "Cache-Control": "no-store" },
          });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Failed to process Collector Crypt verification queue" },
            { status: 400 },
          );
        }
      },
    },
  },
});
