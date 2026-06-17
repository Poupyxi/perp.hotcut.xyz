import { createFileRoute } from "@tanstack/react-router";

function optionalNumber(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getEnv(): Record<string, string | undefined> {
  return (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const key = request.headers.get("x-api-key");
  if (key) return key.trim();
  const url = new URL(request.url);
  return url.searchParams.get("api_key");
}

type VerificationSignal = { id: string; label: string; pass: boolean };

function scoreVerification(row: Record<string, unknown>): { score: number; max: number; signals: VerificationSignal[] } {
  const listingUpdatedAt = typeof row.listing_updated_at === "string" ? Date.parse(row.listing_updated_at) : NaN;
  const recentlyConfirmed = Number.isFinite(listingUpdatedAt) && Date.now() - listingUpdatedAt < 24 * 60 * 60 * 1000;
  const hasPrice = typeof row.listed_price_sol === "number" && (row.listed_price_sol as number) > 0;
  const hasMarketplace = typeof row.listing_marketplace === "string" && (row.listing_marketplace as string).length > 0;
  const hasOwner = typeof row.owner === "string" && (row.owner as string).length > 0;
  const validationOk = (row.validation_status ?? "") === "verified" || (row.metadata_status ?? "") === "ok";

  const signals: VerificationSignal[] = [
    { id: "marketplace", label: "Marketplace confirmed", pass: hasMarketplace },
    { id: "price", label: "Price present", pass: hasPrice },
    { id: "owner", label: "Owner known", pass: hasOwner },
    { id: "recent", label: "Confirmed < 24h", pass: recentlyConfirmed },
    { id: "metadata", label: "Metadata validated", pass: validationOk },
  ];

  const score = signals.filter((s) => s.pass).length;
  return { score, max: signals.length, signals };
}

export const Route = createFileRoute("/api/verified-listed")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const env = getEnv();
        const apiKey = env.VERIFIED_LISTED_API_KEY?.trim();
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

        const { getNftDb } = await import("@/services/nftSqliteDb");
        const url = new URL(request.url);
        const minScore = Math.max(0, Math.min(5, optionalNumber(url.searchParams.get("minScore")) ?? 0));
        const page = Math.max(1, optionalNumber(url.searchParams.get("page")) ?? 1);
        const limit = Math.min(200, Math.max(1, optionalNumber(url.searchParams.get("limit")) ?? 50));
        const category = url.searchParams.get("category");
        const sort = url.searchParams.get("sort") ?? "updated_desc";

        // Only show confirmed-listed NFTs — is_listed=0 alone (never-checked) is not proof of unlisted.
        const where: string[] = ["listing_verification_status = 'verified_listed'", "is_staging = 0"];
        const params: unknown[] = [];
        if (category && category !== "all") {
          where.push("category = ?");
          params.push(category);
        }
        const order = sort === "price_desc"
          ? "COALESCE(listed_price_sol, latest_market_price_sol, 0) DESC"
          : sort === "price_asc"
            ? "COALESCE(listed_price_sol, latest_market_price_sol, 999999999) ASC"
            : "COALESCE(listing_updated_at, last_checked_at, updated_at) DESC";
        params.push(limit, (page - 1) * limit);
        const rows = getNftDb()
          .prepare(`SELECT * FROM nft_assets WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`)
          .all(...params) as Array<Record<string, unknown>>;

        const enriched = rows
          .map((row) => {
            const verification = scoreVerification(row);
            return {
              mint: row.mint,
              name: row.name,
              image: row.image,
              owner: row.owner,
              category: row.category,
              market: row.market,
              collection: row.collection,
              listedPriceSol: row.listed_price_sol,
              listedPriceUsd: row.listed_price_usd,
              listingMarketplace: row.listing_marketplace,
              listingUpdatedAt: row.listing_updated_at,
              sourceCollection: row.source_collection,
              latestProvider: row.latest_provider,
              floorPriceSol: row.floor_price_sol,
              lastSalePriceSol: row.last_sale_price_sol,
              lastSalePriceUsd: row.last_sale_price_usd,
              lastSaleAt: row.last_sale_at,
              metadataStatus: row.metadata_status,
              validationStatus: row.validation_status,
              verification,
            };
          })
          .filter((row) => row.verification.score >= minScore);

        return Response.json(
          { listings: enriched, total: enriched.length, minScore },
          {
            headers: {
              "cache-control": "public, max-age=15",
              "x-api-key-required": apiKey ? "true" : "false",
            },
          },
        );
      },
    },
  },
});
