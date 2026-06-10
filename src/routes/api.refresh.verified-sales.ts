import { createFileRoute } from "@tanstack/react-router";

function env() {
  return (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

function optionalNumber(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function authorized(request: Request) {
  const secret = env().REFRESH_SECRET;
  if (!secret) return false;
  const headerSecret = request.headers.get("x-refresh-secret");
  const auth = request.headers.get("authorization");
  return headerSecret === secret || auth === `Bearer ${secret}`;
}

export const Route = createFileRoute("/api/refresh/verified-sales")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!env().REFRESH_SECRET) {
          return Response.json({ error: "Verified sales refresh endpoint is disabled until REFRESH_SECRET is configured." }, { status: 503 });
        }
        if (!authorized(request)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const url = new URL(request.url);
        const { updateNFTMarketStates } = await import("@/services/nftMarketStateService");
        const result = await updateNFTMarketStates({
          mint: url.searchParams.get("mint"),
          limit: optionalNumber(url.searchParams.get("limit")),
        });

        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
