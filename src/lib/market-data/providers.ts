import { isApprovedMarketSlug } from "@/lib/real-market-data";
import { MARKET_NAMES, getRuntimeEnv, readMarketSourceConfig } from "./config";
import type { MarketProvider, MarketSalesResponse, MarketSourceConfig, NormalizedSale, ProviderStatus } from "./types";

type FetchWindow = { from: Date; to: Date };
type ProviderResult = { sales: NormalizedSale[]; status: ProviderStatus; warnings?: string[] };
type UnknownRecord = Record<string, unknown>;

const SOL_MINT = "So11111111111111111111111111111111111111112";

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function toIsoFromSeconds(value: unknown): string | undefined {
  const seconds = asNumber(value);
  return seconds ? new Date(seconds * 1000).toISOString() : undefined;
}

function toIsoDate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 1_000_000_000_000 ? value : value * 1000).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(value.trim())) {
      return new Date(numeric > 1_000_000_000_000 ? numeric : numeric * 1000).toISOString();
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  return undefined;
}

function marketplaceFromActivitySource(value: unknown): string {
  const source = asString(value)?.toLowerCase() ?? "";
  if (source.includes("tensor")) return "Tensor";
  if (source === "mmm") return "Magic Eden MMM";
  if (source.includes("magiceden") || source.includes("magic_eden")) return "Magic Eden";
  return asString(value) ?? "Magic Eden";
}

function providerEnabled(env: ReturnType<typeof getRuntimeEnv>, flag: "MAGIC_EDEN_ENABLED" | "PHYGITALS_ENABLED" | "COLLECTOR_CRYPT_ENABLED") {
  return (env[flag] ?? "false") === "true";
}

function isWithinWindow(iso: string, window: FetchWindow): boolean {
  const time = new Date(iso).getTime();
  return time >= window.from.getTime() && time <= window.to.getTime();
}

function makeId(parts: Array<string | number | undefined>): string {
  return parts.filter((part) => part !== undefined && part !== "").join(":");
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function marketsFromConfig(config: Record<string, MarketSourceConfig>) {
  return Object.entries(config)
    .filter(([slug]) => isApprovedMarketSlug(slug))
    .map(([slug, marketConfig]) => ({ slug, name: MARKET_NAMES[slug] ?? slug, config: marketConfig ?? {} }));
}

function extractMagicEdenSale(item: unknown, marketSlug: string, symbol: string): NormalizedSale | undefined {
  const row = asRecord(item);
  const type = asString(row.type)?.toLowerCase() ?? asString(row.kind)?.toLowerCase() ?? "";
  if (type && !["buy", "buy_now", "sale", "sold", "accept_bid"].some((saleType) => type.includes(saleType))) return undefined;

  const token = asRecord(row.token);
  const txSignature = asString(row.txId) ?? asString(row.signature) ?? asString(row.transactionSignature);
  const saleTime = toIsoDate(row.blockTime) ?? toIsoDate(row.createdAt) ?? toIsoDate(row.created_at) ?? toIsoDate(row.blockTimestamp) ?? toIsoDate(row.timestamp);
  const usdPrice = asNumber(row.priceUsd);
  const price = usdPrice ?? asNumber(row.price) ?? asNumber(row.listedPrice);
  if (!saleTime || !price) return undefined;
  const tokenMint = asString(row.tokenMint) ?? asString(row.mint);

  return {
    id: makeId(["me", marketSlug, symbol, txSignature, tokenMint, saleTime]),
    marketSlug,
    marketName: MARKET_NAMES[marketSlug] ?? marketSlug,
    assetName: asString(row.tokenName) ?? asString(token.name) ?? asString(row.name) ?? (tokenMint ? `${symbol} ${tokenMint.slice(0, 6)}` : `${symbol} asset`),
    assetImage: asString(row.tokenImg) ?? asString(token.image) ?? asString(row.image),
    grade: asString(row.grade),
    salePrice: price,
    currency: usdPrice ? "USD" : asString(row.currency) ?? "SOL",
    saleTime,
    marketplace: marketplaceFromActivitySource(row.source),
    source: "magic-eden",
    sourceUrl: txSignature ? `https://orbmarkets.io/tx/${txSignature}` : undefined,
    txSignature,
    buyer: asString(row.buyer),
    seller: asString(row.seller),
  };
}

async function fetchMagicEdenSales(window: FetchWindow, config: Record<string, MarketSourceConfig>): Promise<ProviderResult> {
  const env = getRuntimeEnv();
  if (!providerEnabled(env, "MAGIC_EDEN_ENABLED")) {
    return { sales: [], status: { provider: "magic-eden", enabled: false, ok: false, message: "Provider not connected." } };
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (env.MAGIC_EDEN_API_KEY) headers.Authorization = `Bearer ${env.MAGIC_EDEN_API_KEY}`;
  const markets = marketsFromConfig(config).filter((market) => market.config.magicEdenSymbols?.length);
  const sales: NormalizedSale[] = [];
  const warnings: string[] = [];

  if (!markets.length) {
    return { sales, status: { provider: "magic-eden", enabled: false, ok: false, message: "No Magic Eden symbols configured." } };
  }

  for (const market of markets) {
    for (const symbol of market.config.magicEdenSymbols ?? []) {
      try {
        const url = new URL(`https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(symbol)}/activities`);
        url.searchParams.set("offset", "0");
        url.searchParams.set("limit", "500");
        const payload = await fetchJson(url.toString(), { headers });
        const rows = Array.isArray(payload) ? payload : Array.isArray(asRecord(payload).data) ? (asRecord(payload).data as unknown[]) : [];
        for (const row of rows) {
          const sale = extractMagicEdenSale(row, market.slug, symbol);
          if (sale && isWithinWindow(sale.saleTime, window)) sales.push(sale);
        }
      } catch (error) {
        warnings.push(`Magic Eden ${market.name}/${symbol}: ${error instanceof Error ? error.message : "request failed"}`);
      }
    }
  }

  return { sales, warnings, status: { provider: "magic-eden", enabled: true, ok: sales.length > 0, message: sales.length ? `${sales.length} sale(s) fetched.` : "Configured, but no recent sales returned." } };
}

function extractSolscanSale(item: unknown, marketSlug: string): NormalizedSale | undefined {
  const row = asRecord(item);
  const saleTime = toIsoFromSeconds(row.block_time) ?? asString(row.time);
  const price = asNumber(row.price);
  if (!saleTime || !price) return undefined;
  const signature = asString(row.trans_id);
  const currency = asString(row.currency_token) === SOL_MINT ? "SOL" : asString(row.currency_token) ?? "UNKNOWN";

  return {
    id: makeId(["solscan", marketSlug, signature, asString(row.token_address), saleTime]),
    marketSlug,
    marketName: MARKET_NAMES[marketSlug] ?? marketSlug,
    assetName: asString(row.token_name) ?? asString(row.token_address) ?? "Unknown asset",
    salePrice: price,
    currency,
    saleTime,
    marketplace: asString(row.marketplace_address) ?? "Solana marketplace",
    source: "solscan",
    sourceUrl: signature ? `https://orbmarkets.io/tx/${signature}` : undefined,
    txSignature: signature,
    buyer: asString(row.to_address),
    seller: asString(row.from_address),
  };
}

async function fetchSolscanSales(window: FetchWindow, config: Record<string, MarketSourceConfig>): Promise<ProviderResult> {
  const apiKey = getRuntimeEnv().SOLSCAN_API_KEY;
  const markets = marketsFromConfig(config).filter((market) => market.config.solscanCollections?.length);
  const sales: NormalizedSale[] = [];
  const warnings: string[] = [];

  if (!apiKey || !markets.length) {
    return { sales, status: { provider: "solscan", enabled: Boolean(apiKey && markets.length), ok: false, message: !apiKey ? "SOLSCAN_API_KEY is missing." : "No Solscan collections configured." } };
  }

  for (const market of markets) {
    for (const collection of market.config.solscanCollections ?? []) {
      try {
        const url = new URL("https://pro-api.solscan.io/v2.0/nft/activities");
        url.searchParams.set("collection", collection);
        url.searchParams.append("activity_type", "ACTIVITY_NFT_SOLD");
        url.searchParams.set("from_time", Math.floor(window.from.getTime() / 1000).toString());
        url.searchParams.set("to_time", Math.floor(window.to.getTime() / 1000).toString());
        url.searchParams.set("page", "1");
        url.searchParams.set("page_size", "100");
        const payload = await fetchJson(url.toString(), { headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json" } });
        const rows = Array.isArray(asRecord(payload).data) ? (asRecord(payload).data as unknown[]) : [];
        for (const row of rows) {
          const sale = extractSolscanSale(row, market.slug);
          if (sale && isWithinWindow(sale.saleTime, window)) sales.push(sale);
        }
      } catch (error) {
        warnings.push(`Solscan ${market.name}/${collection}: ${error instanceof Error ? error.message : "request failed"}`);
      }
    }
  }

  return { sales, warnings, status: { provider: "solscan", enabled: true, ok: sales.length > 0, message: sales.length ? `${sales.length} sale(s) fetched.` : "Configured, but no recent sales returned." } };
}

export async function fetchMarketSales(days: number): Promise<MarketSalesResponse> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const window = { from, to };
  const config = readMarketSourceConfig();
  const [magicEden, solscan] = await Promise.all([fetchMagicEdenSales(window, config), fetchSolscanSales(window, config)]);
  const ignoredConfiguredMarkets = Object.keys(config).filter((slug) => !isApprovedMarketSlug(slug));
  const providerStatus: ProviderStatus[] = [
    magicEden.status.enabled ? magicEden.status : { ...magicEden.status, message: "Provider not connected." },
    { provider: "tensor", enabled: Boolean(getRuntimeEnv().TENSOR_API_KEY), ok: false, message: "Tensor sales ingestion is prepared but not enabled until API access is confirmed." },
    solscan.status,
    { provider: "helius", enabled: Boolean(getRuntimeEnv().HELIUS_API_KEY), ok: false, message: "Helius fallback is reserved for generic on-chain transaction parsing." },
    { provider: "collector-crypt", enabled: false, ok: false, message: "Provider not connected." },
  ];
  const liveSales = [...magicEden.sales, ...solscan.sales];

  return {
    generatedAt: to.toISOString(),
    from: from.toISOString(),
    to: to.toISOString(),
    days,
    live: liveSales.length > 0,
    sales: liveSales.sort((a, b) => new Date(b.saleTime).getTime() - new Date(a.saleTime).getTime()),
    providerStatus,
    warnings: [
      ...(magicEden.warnings ?? []),
      ...(solscan.warnings ?? []),
      ...(ignoredConfiguredMarkets.length ? ["Ignored non-approved market sources: " + ignoredConfiguredMarkets.join(", ")] : []),
    ],
  };
}
