import type { FetchSalesParams, NormalizedSale, ProviderSalesConnector, ProviderSalesStatus } from "../types";
import { asNumber, asRecord, asString, fetchJson, isWithinWindow, nowStatus, rowsFromPayload, toIsoDate } from "../utils";
import { getIngestionEnv } from "../config";

function isEnabled(env: Record<string, string | undefined>) {
  return (env.MAGIC_EDEN_ENABLED ?? "false") === "true";
}

function isExecutedSale(row: Record<string, unknown>): boolean {
  const type = `${asString(row.type) ?? asString(row.kind) ?? ""}`.toLowerCase();
  return ["buy", "buynow", "buy_now", "sale", "sold", "accept_bid"].some((saleType) => type.includes(saleType));
}

function marketplaceFromSource(value: unknown): string {
  const source = asString(value)?.toLowerCase() ?? "";
  if (source.includes("tensor")) return "Tensor";
  if (source === "mmm") return "Magic Eden MMM";
  if (source.includes("magiceden") || source.includes("magic_eden")) return "Magic Eden";
  return asString(value) ?? "Magic Eden";
}

function normalizeMagicEdenSale(rowValue: unknown, market: string, symbol: string): NormalizedSale | undefined {
  const row = asRecord(rowValue);
  if (!isExecutedSale(row)) return undefined;

  const token = asRecord(row.token);
  const txHash = asString(row.txId) ?? asString(row.signature) ?? asString(row.transactionSignature);
  const timestamp = toIsoDate(row.blockTime) ?? toIsoDate(row.createdAt) ?? toIsoDate(row.created_at) ?? toIsoDate(row.blockTimestamp) ?? toIsoDate(row.timestamp);
  const priceUsd = asNumber(row.priceUsd);
  const price = priceUsd ?? asNumber(row.price) ?? asNumber(row.listedPrice);
  if (!timestamp || !price) return undefined;

  const assetMint = asString(row.tokenMint) ?? asString(row.mint);
  const currency = priceUsd ? "USD" : asString(row.currency) ?? "SOL";
  return {
    provider: "magic-eden",
    market,
    assetName: asString(row.tokenName) ?? asString(token.name) ?? asString(row.name) ?? (assetMint ? `${symbol} ${assetMint.slice(0, 6)}` : `${symbol} asset`),
    assetMint,
    imageUrl: asString(row.tokenImg) ?? asString(token.image) ?? asString(row.image),
    txHash,
    buyerWallet: asString(row.buyer),
    sellerWallet: asString(row.seller),
    priceSol: currency === "SOL" ? price : null,
    priceUsd: currency === "USD" ? price : null,
    currency,
    timestamp,
    blockSlot: asNumber(row.slot) ?? null,
    rawPayload: row,
    validationStatus: "unverified",
  };
}

export class MagicEdenSalesConnector implements ProviderSalesConnector {
  providerId = "magic-eden" as const;
  private status: ProviderSalesStatus = nowStatus(this.providerId, "disabled", "Provider not connected.");

  getStatus() {
    return this.status;
  }

  async fetchSales(params: FetchSalesParams): Promise<NormalizedSale[]> {
    const env = getIngestionEnv();
    if (!isEnabled(env)) {
      this.status = nowStatus(this.providerId, "disabled", "Provider not connected.");
      return [];
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (env.MAGIC_EDEN_API_KEY) headers.Authorization = `Bearer ${env.MAGIC_EDEN_API_KEY}`;

    const markets = Object.entries(params.markets).filter(([, config]) => config.magicEdenSymbols?.length);
    if (!markets.length) {
      this.status = nowStatus(this.providerId, "unavailable", "No Magic Eden collection symbols configured.");
      return [];
    }

    const sales: NormalizedSale[] = [];
    const errors: string[] = [];
    for (const [market, config] of markets) {
      for (const symbol of config.magicEdenSymbols ?? []) {
        try {
          const url = new URL(`https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(symbol)}/activities`);
          url.searchParams.set("offset", "0");
          url.searchParams.set("limit", String(params.limit ?? 500));
          const payload = await fetchJson(url.toString(), { headers });
          for (const row of rowsFromPayload(payload)) {
            const sale = normalizeMagicEdenSale(row, market, symbol);
            if (sale && isWithinWindow(sale.timestamp, params.from, params.to)) sales.push(sale);
          }
        } catch (error) {
          errors.push(`${market}/${symbol}: ${error instanceof Error ? error.message : "request failed"}`);
        }
      }
    }

    this.status = errors.length && !sales.length
      ? nowStatus(this.providerId, "error", errors.join("; "), 0)
      : nowStatus(this.providerId, "live", sales.length ? `${sales.length} executed sale(s) fetched.` : "Configured, but no executed sales in window.", sales.length);
    return sales;
  }
}
