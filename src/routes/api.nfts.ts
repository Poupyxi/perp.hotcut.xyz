import { createFileRoute } from "@tanstack/react-router";

function optionalNumber(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalBoolean(value: string | null, fallback: boolean) {
  if (value === null) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function optionalBooleanNullable(value: string | null) {
  if (value === null) return null;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export const Route = createFileRoute("/api/nfts")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { getNFTMarketStates } = await import("@/services/nftMarketStateService");
        const url = new URL(request.url);
        const result = await getNFTMarketStates({
          page: optionalNumber(url.searchParams.get("page")) ?? 1,
          limit: optionalNumber(url.searchParams.get("limit")) ?? 50,
          search: url.searchParams.get("search"),
          market: url.searchParams.get("market"),
          category: url.searchParams.get("category"),
          status: url.searchParams.get("status"),
          provider: url.searchParams.get("provider"),
          hasSale: optionalBooleanNullable(url.searchParams.get("hasSale")),
          listedOnly: optionalBoolean(url.searchParams.get("listedOnly"), false),
          soldOnly: optionalBoolean(url.searchParams.get("soldOnly"), false),
          includeOther: optionalBoolean(url.searchParams.get("includeOther"), false),
          includeUnknown: optionalBoolean(url.searchParams.get("includeUnknown"), false),
          includeStaging: optionalBoolean(url.searchParams.get("includeStaging"), false),
          sort: url.searchParams.get("sort"),
        });

        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
