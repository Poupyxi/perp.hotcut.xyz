import { createFileRoute } from "@tanstack/react-router";

function env() {
  return (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

function authorized(request: Request) {
  const secret = env().REFRESH_SECRET;
  if (!secret) return false;
  return request.headers.get("x-refresh-secret") === secret || request.headers.get("authorization") === `Bearer ${secret}`;
}

function optionalNumber(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalBoolean(value: string | null) {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export const Route = createFileRoute("/api/scan/nft-market-states")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!env().REFRESH_SECRET) {
          return Response.json({ error: "NFT scanner endpoint is disabled until REFRESH_SECRET is configured." }, { status: 503 });
        }
        if (!authorized(request)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const url = new URL(request.url);
        const { scanAllNFTMarketStates } = await import("@/services/nftMarketStateScannerService");
        const result = await scanAllNFTMarketStates({
          mint: url.searchParams.get("mint"),
          limit: optionalNumber(url.searchParams.get("limit")),
          all: optionalBoolean(url.searchParams.get("all")) ?? false,
          dryRun: optionalBoolean(url.searchParams.get("dryRun")),
        });

        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
