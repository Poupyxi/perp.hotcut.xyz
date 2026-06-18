import { createFileRoute } from "@tanstack/react-router";

function env(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

function extractBearer(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const key = request.headers.get("x-api-key");
  if (key) return key.trim();
  const url = new URL(request.url);
  return url.searchParams.get("api_key");
}

export const Route = createFileRoute("/api/gacha/admin")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const apiKey = env().GACHA_ADMIN_API_KEY?.trim();
        if (apiKey) {
          const provided = extractBearer(request);
          const sameOrigin = request.headers.get("sec-fetch-site") === "same-origin";
          if (provided !== apiKey && !sameOrigin) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
            });
          }
        }

        const { listRecentDraws, getGachaDb } = await import("@/services/gacha/db");
        const { loadGachaOdds } = await import("@/services/gacha/odds");
        const { serverWalletAddress, getConnection } = await import("@/services/gacha/solana");

        const draws = listRecentDraws(50);
        const ledger = getGachaDb()
          .prepare(`SELECT * FROM gacha_treasury_ledger ORDER BY id DESC LIMIT 50`)
          .all();
        const odds = loadGachaOdds();
        const serverWallet = serverWalletAddress();
        let balanceSol: number | null = null;
        try {
          const { PublicKey } = await import("@solana/web3.js");
          const bal = await getConnection().getBalance(new PublicKey(serverWallet));
          balanceSol = bal / 1_000_000_000;
        } catch {
          balanceSol = null;
        }

        return Response.json(
          { draws, ledger, odds, serverWallet, balanceSol, authRequired: !!apiKey },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
