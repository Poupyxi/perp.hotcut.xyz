import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/helius/keys")({
  server: {
    handlers: {
      GET: async () => {
        const { getHeliusKeyStats } = await import("@/services/heliusApiKeyRotation");
        return Response.json(getHeliusKeyStats(), { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
