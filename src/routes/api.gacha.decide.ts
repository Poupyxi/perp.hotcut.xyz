import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/gacha/decide")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getDraw, updateDraw, appendTreasury } = await import("@/services/gacha/db");
        const { loadGachaOdds } = await import("@/services/gacha/odds");
        const { refundPlayer } = await import("@/services/gacha/refund");
        const { mintTestCardToPlayer } = await import("@/services/gacha/nft");
        const { dropServerSeed } = await import("@/services/gacha/seedStash");

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "content-type": "application/json" } });
        }
        const parsed = body as { drawId?: unknown; action?: unknown };
        const drawId = typeof parsed.drawId === "string" ? parsed.drawId : "";
        const action = typeof parsed.action === "string" ? parsed.action : "";
        if (!drawId || !["accept", "refuse"].includes(action)) {
          return new Response(JSON.stringify({ error: "drawId + action (accept|refuse) required" }), { status: 400, headers: { "content-type": "application/json" } });
        }

        const draw = getDraw(drawId);
        if (!draw) return new Response(JSON.stringify({ error: "draw not found" }), { status: 404, headers: { "content-type": "application/json" } });

        // Idempotence: if already finalized, return current state.
        if (draw.status === "accepted" || draw.status === "refused" || draw.status === "expired" || draw.status === "failed") {
          return Response.json({ status: draw.status, draw, replay: true }, { headers: { "cache-control": "no-store" } });
        }

        if (draw.status !== "revealed") {
          return new Response(JSON.stringify({ error: `Draw is in status ${draw.status}, decision not allowed yet` }), { status: 409, headers: { "content-type": "application/json" } });
        }

        const odds = loadGachaOdds();
        const revealedAt = draw.revealed_at ? Date.parse(draw.revealed_at) : Date.now();
        const expired = Date.now() - revealedAt > odds.decisionWindowSeconds * 1000;
        const effectiveAction = expired ? "refuse" : action;

        if (effectiveAction === "accept") {
          try {
            const metadataUri = `${process.env.PUBLIC_BASE_URL ?? "https://perp.hotcut.xyz"}/gacha/metadata/test-card.json`;
            const cardName = `Gacha ${draw.tier_name ?? "tier"} (devnet)`;
            const nft = await mintTestCardToPlayer({
              playerWallet: draw.player_wallet,
              cardName,
              metadataUri,
            });
            updateDraw(drawId, {
              decision: "accept",
              decision_at: new Date().toISOString(),
              decision_signature: nft.signature,
              payout_sol: 0,
              status: "accepted",
            });
            appendTreasury({
              drawId,
              kind: "mint_fee",
              amountSol: 0,
              signature: nft.signature,
              memo: `mint ${nft.mintAddress} -> ${draw.player_wallet}`,
            });
            dropServerSeed(drawId);
            return Response.json({ status: "accepted", drawId, nft }, { headers: { "cache-control": "no-store" } });
          } catch (err) {
            const message = err instanceof Error ? err.message : "Mint failed";
            // Fallback per config.
            const fb = odds.fallbackOnAcceptFail;
            if (fb === "refund") {
              const amount = (draw.tier_value_sol ?? 0) * odds.refundRate;
              try {
                const refund = await refundPlayer({ playerWallet: draw.player_wallet, amountSol: amount });
                updateDraw(drawId, {
                  decision: "refuse",
                  decision_at: new Date().toISOString(),
                  decision_signature: refund.signature,
                  payout_sol: amount,
                  status: "refused",
                });
                appendTreasury({
                  drawId,
                  kind: "refund_out",
                  amountSol: amount,
                  signature: refund.signature,
                  memo: `accept-fallback=refund (${message})`,
                });
                dropServerSeed(drawId);
                return Response.json({ status: "refused", drawId, reason: `mint failed (${message}) — refunded`, refund }, { headers: { "cache-control": "no-store" } });
              } catch (refundErr) {
                updateDraw(drawId, { status: "failed", decision: "accept_failed" });
                return new Response(JSON.stringify({ error: `Mint failed and refund failed: ${refundErr instanceof Error ? refundErr.message : refundErr}` }), { status: 500, headers: { "content-type": "application/json" } });
              }
            }
            updateDraw(drawId, { status: "failed", decision: "accept_failed" });
            return new Response(JSON.stringify({ error: `Mint failed: ${message}. fallback=${fb} not implemented yet.` }), { status: 500, headers: { "content-type": "application/json" } });
          }
        }

        // Refuse path
        const amount = (draw.tier_value_sol ?? 0) * odds.refundRate;
        if (amount <= 0) {
          updateDraw(drawId, { decision: "refuse", decision_at: new Date().toISOString(), payout_sol: 0, status: expired ? "expired" : "refused" });
          appendTreasury({ drawId, kind: "expired_kept", amountSol: draw.pack_price_sol, memo: "refund amount 0" });
          dropServerSeed(drawId);
          return Response.json({ status: expired ? "expired" : "refused", drawId, refund: null }, { headers: { "cache-control": "no-store" } });
        }
        try {
          const refund = await refundPlayer({ playerWallet: draw.player_wallet, amountSol: amount });
          updateDraw(drawId, {
            decision: expired ? "expired" : "refuse",
            decision_at: new Date().toISOString(),
            decision_signature: refund.signature,
            payout_sol: amount,
            status: expired ? "expired" : "refused",
          });
          appendTreasury({ drawId, kind: "refund_out", amountSol: amount, signature: refund.signature, memo: expired ? "expired-refund" : "refuse-refund" });
          dropServerSeed(drawId);
          return Response.json({ status: expired ? "expired" : "refused", drawId, refund }, { headers: { "cache-control": "no-store" } });
        } catch (err) {
          updateDraw(drawId, { status: "failed" });
          return new Response(JSON.stringify({ error: `Refund failed: ${err instanceof Error ? err.message : err}` }), { status: 500, headers: { "content-type": "application/json" } });
        }
      },
    },
  },
});
