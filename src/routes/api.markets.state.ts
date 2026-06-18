import { createFileRoute } from "@tanstack/react-router";

type CategoryRow = {
  category: string;
  total: number;
  hold: number;
  listed: number;
  bid: number;
  makeOffer: number;
  sold: number;
  transferred: number;
  minted: number;
  unknownState: number;
};

const CACHE_TTL_MS = 30_000;
let cache: { expiresAt: number; body: string } | null = null;

export const Route = createFileRoute("/api/markets/state")({
  server: {
    handlers: {
      GET: async () => {
        const now = Date.now();
        if (cache && cache.expiresAt > now) {
          return new Response(cache.body, {
            headers: { "content-type": "application/json", "cache-control": "public, max-age=30", "x-cache": "HIT" },
          });
        }

        const { getNftDb } = await import("@/services/nftSqliteDb");
        const db = getNftDb();

        const rows = db
          .prepare(
            `
            SELECT
              COALESCE(NULLIF(category, ''), 'unknown') AS category,
              COUNT(*) AS total,
              SUM(CASE WHEN current_state = 'owned' THEN 1 ELSE 0 END) AS hold,
              SUM(CASE WHEN current_state = 'listed' OR is_listed = 1 THEN 1 ELSE 0 END) AS listed,
              SUM(CASE WHEN last_activity_type = 'bid' THEN 1 ELSE 0 END) AS bid,
              SUM(CASE WHEN last_activity_type = 'make_offer' THEN 1 ELSE 0 END) AS make_offer,
              SUM(CASE WHEN last_activity_type IN ('sold', 'bought') THEN 1 ELSE 0 END) AS sold,
              SUM(CASE WHEN last_activity_type = 'transferred' THEN 1 ELSE 0 END) AS transferred,
              SUM(CASE WHEN last_activity_type = 'minted' THEN 1 ELSE 0 END) AS minted,
              SUM(CASE WHEN current_state IS NULL OR current_state = '' THEN 1 ELSE 0 END) AS unknown_state
            FROM nft_assets
            WHERE is_staging = 0
            GROUP BY COALESCE(NULLIF(category, ''), 'unknown')
            ORDER BY total DESC
          `,
          )
          .all() as Array<Record<string, unknown>>;

        const categories: CategoryRow[] = rows.map((row) => ({
          category: String(row.category),
          total: Number(row.total) || 0,
          hold: Number(row.hold) || 0,
          listed: Number(row.listed) || 0,
          bid: Number(row.bid) || 0,
          makeOffer: Number(row.make_offer) || 0,
          sold: Number(row.sold) || 0,
          transferred: Number(row.transferred) || 0,
          minted: Number(row.minted) || 0,
          unknownState: Number(row.unknown_state) || 0,
        }));

        const totals = categories.reduce(
          (acc, row) => {
            acc.total += row.total;
            acc.hold += row.hold;
            acc.listed += row.listed;
            acc.bid += row.bid;
            acc.makeOffer += row.makeOffer;
            acc.sold += row.sold;
            acc.transferred += row.transferred;
            acc.minted += row.minted;
            acc.unknownState += row.unknownState;
            return acc;
          },
          { total: 0, hold: 0, listed: 0, bid: 0, makeOffer: 0, sold: 0, transferred: 0, minted: 0, unknownState: 0 },
        );

        const lastCheckedRow = db
          .prepare(`SELECT MAX(last_checked_at) AS last_checked_at FROM nft_assets`)
          .get() as { last_checked_at: string | null };

        const body = JSON.stringify({
          categories,
          totals,
          lastCheckedAt: lastCheckedRow?.last_checked_at ?? null,
          generatedAt: new Date().toISOString(),
        });

        cache = { expiresAt: Date.now() + CACHE_TTL_MS, body };

        return new Response(body, {
          headers: { "content-type": "application/json", "cache-control": "public, max-age=30", "x-cache": "MISS" },
        });
      },
    },
  },
});
