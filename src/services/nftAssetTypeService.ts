export type RwaCollectibleAssetType = "card" | "sealed" | "comic" | "merch" | "unknown";
export type RwaCollectiblePublicGroup = "card" | "other";

type AssetTypeInput = {
  name?: string | null;
  description?: string | null;
  collection?: string | null;
  attributes_json?: unknown;
  attributes?: unknown;
  raw?: unknown;
};

const SEALED_KEYWORDS = [
  "sealed",
  "booster box",
  "booster pack",
  "pack",
  "box",
  "case",
  "etb",
  "elite trainer box",
  "tin",
  "bundle",
  "blister",
  "display",
  "wax",
  "hobby box",
  "retail box",
  "starter deck",
  "structure deck",
  "collector booster",
  "draft booster",
  "set booster",
];

const COMIC_KEYWORDS = [
  "comic",
  "comics",
  "issue",
  "variant cover",
  "cgc comic",
  "signed comic",
  "graded comic",
  "marvel",
  "dc comics",
];

const MERCH_KEYWORDS = [
  "merch",
  "merchandise",
  "apparel",
  "hoodie",
  "shirt",
  "t-shirt",
  "poster",
  "figure",
  "toy",
  "accessory",
  "collectible figure",
];

const CARD_KEYWORDS = [
  "card",
  "psa",
  "bgs",
  "cgc card",
  "sgc",
  "graded card",
  "rookie card",
  "holo",
  "refractor",
  "prizm",
  "topps",
  "panini",
  "upper deck",
  "bowman",
  "card number",
  "gem mint",
  "mint 10",
  "psa 10",
  "psa 9",
  "bgs 10",
  "bgs 9.5",
];

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\uFFFD/g, "e")
    .toLowerCase();
}

function flatten(value: unknown, depth = 0): string {
  if (value === null || value === undefined || depth > 4) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => flatten(item, depth + 1)).join(" ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["raw_helius_json", "rawPayload", "instructions", "accountData"].includes(key))
      .map(([key, item]) => `${key} ${flatten(item, depth + 1)}`)
      .join(" ");
  }
  return "";
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(normalize(keyword)));
}

export function publicGroupForAssetType(assetType: RwaCollectibleAssetType): RwaCollectiblePublicGroup {
  return assetType === "card" ? "card" : "other";
}

const GRADING_PATTERN = /\b(?:psa|cgc|bgs|sgc|ace|gma|csg)\s*\.?\s*(?:10|9(?:\.\d)?|8(?:\.\d)?|7(?:\.\d)?|6(?:\.\d)?|5|4|3|2|1)\b/i;
const CARD_NUMBER_PATTERN = /#\s*[a-z]{0,3}\d+/i;
const CARD_YEAR_PATTERN = /\b(?:19|20)\d{2}\b/;
const TCG_RARITY_PATTERN = /\b(?:vmax|vstar|gx|ex|secret rare|rainbow rare|full art|alt art|holo|reverse holo|first edition|1st edition|trainer gallery|illustration rare|special illustration rare)\b/i;

export function detectCollectibleAssetType(nft: AssetTypeInput): RwaCollectibleAssetType {
  const haystack = normalize([
    nft.name,
    nft.description,
    nft.collection,
    flatten(nft.attributes_json),
    flatten(nft.attributes),
    flatten(nft.raw),
  ].join(" "));

  const hasSealed = includesAny(haystack, SEALED_KEYWORDS);
  const hasComic = includesAny(haystack, COMIC_KEYWORDS);
  const hasMerch = includesAny(haystack, MERCH_KEYWORDS);
  const hasCardKeyword = includesAny(haystack, CARD_KEYWORDS);
  const hasGrading = GRADING_PATTERN.test(haystack);
  const hasTcgRarity = TCG_RARITY_PATTERN.test(haystack);
  const hasCardNumber = CARD_NUMBER_PATTERN.test(haystack) && CARD_YEAR_PATTERN.test(haystack);
  const hasCard = hasCardKeyword || hasGrading || hasTcgRarity || hasCardNumber;

  if (hasSealed) return "sealed";
  if (hasMerch) return "merch";
  if (hasComic && !hasCard) return "comic";
  if (hasCard) return "card";
  if (hasComic) return "comic";
  return "unknown";
}
