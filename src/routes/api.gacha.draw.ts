import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/gacha/draw")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { loadGachaOdds } = await import("@/services/gacha/odds");
        const { generateDrawId, generateServerSeed, commit } = await import("@/services/gacha/rng");
        const { insertDraw } = await import("@/services/gacha/db");
        const { serverWalletAddress, isValidPublicKey, solToLamports } = await import("@/services/gacha/solana");
        const { isAllowedRegion } = await import("@/services/gacha/geo");

        if (!isAllowedRegion(request)) {
          return new Response(JSON.stringify({ error: "Region not allowed" }), {
            status: 451,
            headers: { "content-type": "application/json" },
          });
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        const parsed = body as { playerWallet?: unknown; clientNonce?: unknown };
        const playerWallet = typeof parsed.playerWallet === "string" ? parsed.playerWallet.trim() : "";
        const clientNonce = typeof parsed.clientNonce === "string" ? parsed.clientNonce.trim() : "";

        if (!playerWallet || !isValidPublicKey(playerWallet)) {
          return new Response(JSON.stringify({ error: "Missing or invalid playerWallet" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (!clientNonce || clientNonce.length < 8 || clientNonce.length > 128) {
          return new Response(JSON.stringify({ error: "clientNonce must be 8-128 chars" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }

        let odds;
        try {
          odds = loadGachaOdds();
        } catch (err) {
          return new Response(
            JSON.stringify({ error: err instanceof Error ? err.message : "Invalid odds config" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        const drawId = generateDrawId();
        const serverSeedHex = generateServerSeed();
        const commitHex = commit(serverSeedHex, drawId);

        insertDraw({
          drawId,
          playerWallet,
          clientNonce,
          commitHex,
          packPriceSol: odds.packPriceSol,
          oddsSnapshotJson: JSON.stringify(odds),
        });

        // Server seed kept secret in memory until reveal.
        const { stashServerSeed } = await import("@/services/gacha/seedStash");
        stashServerSeed(drawId, serverSeedHex);

        return Response.json(
          {
            drawId,
            commitHex,
            paymentTo: serverWalletAddress(),
            packPriceLamports: solToLamports(odds.packPriceSol),
            packPriceSol: odds.packPriceSol,
            decisionWindowSeconds: odds.decisionWindowSeconds,
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
