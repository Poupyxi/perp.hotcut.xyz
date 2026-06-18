import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/gacha/odds")({
  server: {
    handlers: {
      GET: async () => {
        const { loadGachaOdds, expectedValueSol, houseEdge } = await import("@/services/gacha/odds");
        try {
          const odds = loadGachaOdds();
          return Response.json(
            { odds, ev: expectedValueSol(odds), edge: houseEdge(odds) },
            { headers: { "cache-control": "public, max-age=10" } },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to load odds";
          return new Response(JSON.stringify({ error: message }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
      },
    },
  },
});
