import { getIngestionEnv } from "../config";
import type { FetchSalesParams, NormalizedSale, ProviderSalesConnector, ProviderSalesStatus } from "../types";
import { fetchJson, isWithinWindow, nowStatus } from "../utils";
import { normalizeGenericPayload } from "./generic-json";

function isEnabled(env: Record<string, string | undefined>) {
  return (env.COLLECTOR_CRYPT_ENABLED ?? "false") === "true";
}

export class CollectorCryptSalesConnector implements ProviderSalesConnector {
  providerId = "collector-crypt" as const;
  private status: ProviderSalesStatus = nowStatus(this.providerId, "disabled", "Provider not connected.");

  getStatus() {
    return this.status;
  }

  async fetchSales(params: FetchSalesParams): Promise<NormalizedSale[]> {
    const env = getIngestionEnv();
    if (!isEnabled(env) || !env.COLLECTOR_CRYPT_API_URL) {
      this.status = nowStatus(this.providerId, "disabled", "Provider not connected.");
      return [];
    }
    if (!env.COLLECTOR_CRYPT_SALES_PATH) {
      this.status = nowStatus(this.providerId, "needs_endpoint", "Collector Crypt needs a confirmed sales/fills endpoint. Listings are not ingested as sales.");
      return [];
    }

    const base = env.COLLECTOR_CRYPT_API_URL.replace(/\/$/, "");
    const path = env.COLLECTOR_CRYPT_SALES_PATH.startsWith("/") ? env.COLLECTOR_CRYPT_SALES_PATH : `/${env.COLLECTOR_CRYPT_SALES_PATH}`;
    const markets = Object.entries(params.markets).filter(([, config]) => config.collectorCryptMarkets?.length);
    const targets = markets.length ? markets : [["pokemon-cards", { collectorCryptMarkets: ["default"] }]] as Array<[string, { collectorCryptMarkets?: string[] }]>;
    const sales: NormalizedSale[] = [];
    const errors: string[] = [];

    for (const [market, config] of targets) {
      for (const sourceMarket of config.collectorCryptMarkets ?? []) {
        try {
          const url = new URL(`${base}${path}`);
          if (sourceMarket !== "default") url.searchParams.set("market", sourceMarket);
          url.searchParams.set("from", params.from.toISOString());
          url.searchParams.set("to", params.to.toISOString());
          const payload = await fetchJson(url.toString(), { headers: { accept: "application/json" } });
          sales.push(...normalizeGenericPayload(payload, this.providerId, market).filter((sale) => isWithinWindow(sale.timestamp, params.from, params.to)));
        } catch (error) {
          errors.push(`${market}/${sourceMarket}: ${error instanceof Error ? error.message : "request failed"}`);
        }
      }
    }

    this.status = errors.length && !sales.length
      ? nowStatus(this.providerId, "error", errors.join("; "), 0)
      : nowStatus(this.providerId, "live", sales.length ? `${sales.length} executed sale(s) fetched.` : "Configured, but no executed sales in window.", sales.length);
    return sales;
  }
}
