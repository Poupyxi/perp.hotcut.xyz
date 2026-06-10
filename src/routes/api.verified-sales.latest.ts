import { createFileRoute } from "@tanstack/react-router";

function optionalNumber(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export const Route = createFileRoute("/api/verified-sales/latest")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { getVerifiedSales } = await import("@/services/rwaNftMarketEventService");
        const url = new URL(request.url);
        const result = await getVerifiedSales({
          page: 1,
          limit: optionalNumber(url.searchParams.get("limit")) ?? 20,
          hideTestSales: url.searchParams.get("hideTestSales") !== "false",
          sort: "newest",
        });

        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
