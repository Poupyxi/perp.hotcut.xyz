import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/gacha/confirm-payment")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getDraw, updateDraw, appendTreasury } = await import("@/services/gacha/db");
        const { verifyPaymentTransfer, solToLamports } = await import("@/services/gacha/solana");
        const { consumeServerSeed } = await import("@/services/gacha/seedStash");
        const { rollDraw } = await import("@/services/gacha/rng");
        const { pickCardForTier } = await import("@/services/gacha/prices");
        const { loadGachaOdds } = await import("@/services/gacha/odds");

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        const parsed = body as { drawId?: unknown; signature?: unknown };
        const drawId = typeof parsed.drawId === "string" ? parsed.drawId : "";
        const signature = typeof parsed.signature === "string" ? parsed.signature : "";
        if (!drawId || !signature) {
          return new Response(JSON.stringify({ error: "drawId and signature required" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }

        const draw = getDraw(drawId);
        if (!draw) return new Response(JSON.stringify({ error: "draw not found" }), { status: 404, headers: { "content-type": "application/json" } });
        if (draw.status !== "awaiting_payment") {
          return Response.json({ status: draw.status, draw }, { headers: { "cache-control": "no-store" } });
        }

        const expectedLamports = solToLamports(draw.pack_price_sol);
        const verification = await verifyPaymentTransfer({
          signature,
          expectedFrom: draw.player_wallet,
          expectedLamports,
        });
        if (!verification.ok) {
          return new Response(
            JSON.stringify({ error: verification.reason ?? "Payment not verified" }),
            { status: 402, headers: { "content-type": "application/json" } },
          );
        }

        const serverSeed = consumeServerSeed(drawId);
        if (!serverSeed) {
          return new Response(
            JSON.stringify({ error: "Server seed expired. Restart the draw." }),
            { status: 410, headers: { "content-type": "application/json" } },
          );
        }

        const odds = loadGachaOdds();
        const rolled = rollDraw({
          odds,
          drawId,
          serverSeedHex: serverSeed,
          clientNonce: draw.client_nonce,
        });
        const card = await pickCardForTier(rolled.tier, rolled.valueSol);

        updateDraw(drawId, {
          payment_signature: signature,
          payment_confirmed_at: new Date().toISOString(),
          revealed_at: new Date().toISOString(),
          server_seed_hex: serverSeed,
          tier_name: rolled.tier.name,
          tier_value_sol: rolled.valueSol,
          status: "revealed",
        });

        appendTreasury({
          drawId,
          kind: "pack_in",
          amountSol: draw.pack_price_sol,
          signature,
          memo: "pack payment received",
        });

        return Response.json(
          {
            status: "revealed",
            drawId,
            commitHex: draw.commit_hex,
            serverSeedHex: serverSeed,
            tier: rolled.tier,
            valueSol: rolled.valueSol,
            card,
            decisionWindowSeconds: odds.decisionWindowSeconds,
            revealedAt: new Date().toISOString(),
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
