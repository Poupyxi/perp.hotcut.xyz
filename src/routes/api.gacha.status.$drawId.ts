import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/gacha/status/$drawId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { getDraw } = await import("@/services/gacha/db");
        const draw = getDraw(params.drawId);
        if (!draw) {
          return new Response(JSON.stringify({ error: "draw not found" }), { status: 404, headers: { "content-type": "application/json" } });
        }
        return Response.json({ draw }, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
