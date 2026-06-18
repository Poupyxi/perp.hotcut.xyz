// PriceProvider — abstraction over an external listing price source.
// MVP default: stub backed by `gacha-odds.json` tier ranges (already what /draw uses).
// In the perp-rwa app we also expose `/api/verified-listed` which returns real
// listing prices from Helius DAS. When PRICE_API_URL is set this provider can
// query it to pick a real on-listing card matching the rolled tier value.
//
// TODO (production): match the rolled tier value to the cheapest available
// listing on the live market (snipe-style) and lock it for the decision window.

import type { GachaTier } from "./odds";

export type RolledCard = {
  name: string;
  imageUrl: string;
  mintHint: string | null;
  source: "stub" | "verified-listed";
};

function env(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

const STUB_CARDS: Record<string, RolledCard[]> = {
  jackpot: [
    { name: "Charizard 1st Edition (devnet stub)", imageUrl: "/iconpokemon.png", mintHint: null, source: "stub" },
    { name: "Pikachu Illustrator (devnet stub)", imageUrl: "/iconpokemon.png", mintHint: null, source: "stub" },
  ],
  break_even: [
    { name: "Holo Ribombee PSA 9 (devnet stub)", imageUrl: "/iconpokemon.png", mintHint: null, source: "stub" },
    { name: "Holo Espeon V (devnet stub)", imageUrl: "/iconpokemon.png", mintHint: null, source: "stub" },
  ],
  basse: [
    { name: "Common Bulbasaur (devnet stub)", imageUrl: "/iconpokemon.png", mintHint: null, source: "stub" },
    { name: "Common Magikarp (devnet stub)", imageUrl: "/iconpokemon.png", mintHint: null, source: "stub" },
  ],
};

function pickStub(tier: GachaTier): RolledCard {
  const pool = STUB_CARDS[tier.name] ?? STUB_CARDS.basse;
  return pool[Math.floor(Math.random() * pool.length)];
}

export async function pickCardForTier(tier: GachaTier, valueSol: number): Promise<RolledCard> {
  const priceApiUrl = env().PRICE_API_URL?.trim();
  const priceApiKey = env().PRICE_API_KEY?.trim();
  if (!priceApiUrl) return pickStub(tier);

  try {
    const url = new URL(priceApiUrl);
    url.searchParams.set("sort", "price_asc");
    url.searchParams.set("limit", "20");
    const res = await fetch(url.toString(), {
      headers: {
        accept: "application/json",
        ...(priceApiKey ? { Authorization: `Bearer ${priceApiKey}` } : {}),
      },
    });
    if (!res.ok) return pickStub(tier);
    const payload = (await res.json()) as { listings?: Array<{ name?: string; image?: string; mint?: string; listedPriceSol?: number }> };
    const listings = (payload.listings ?? []).filter((l) => typeof l.listedPriceSol === "number");
    if (listings.length === 0) return pickStub(tier);
    // Pick the listing closest to the rolled value.
    const target = valueSol;
    const sorted = listings.slice().sort((a, b) => Math.abs((a.listedPriceSol ?? 0) - target) - Math.abs((b.listedPriceSol ?? 0) - target));
    const pick = sorted[0];
    return {
      name: pick.name ?? "Unnamed card",
      imageUrl: pick.image ?? "/iconpokemon.png",
      mintHint: pick.mint ?? null,
      source: "verified-listed",
    };
  } catch {
    return pickStub(tier);
  }
}
