import { getIngestionEnv } from "../config";
import type { FetchSalesParams, NormalizedSale, ProviderSalesConnector, ProviderSalesStatus } from "../types";
import { fetchJson, isWithinWindow, nowStatus } from "../utils";
import { normalizeGenericPayload } from "./generic-json";

function isEnabled(env: Record<string, string | undefined>) {
  return (env.PHYGITALS_ENABLED ?? "false") === "true";
}

export class PhygitalsSalesConnector implements ProviderSalesConnector {
  providerId = "phygitals" as const;
  private status: ProviderSalesStatus = nowStatus(this.providerId, "disabled", "Provider not connected.");

  getStatus() {
    return this.status;
  }

  async fetchSales(params: FetchSalesParams): Promise<NormalizedSale[]> {
    const env = getIngestionEnv();
    if (!isEnabled(env) || !env.PHYGITALS_API_URL) {
      this.status = nowStatus(this.providerId, "disabled", "Provider not connected.");
      return [];
    }

    const markets = Object.entries(params.markets).filter(([, config]) => config.phygitalsMarkets?.length);
    const targets = markets.length ? markets : [["other-cards", { phygitalsMarkets: ["default"] }]] as Array<[string, { phygitalsMarkets?: string[] }]>;
    const sales: NormalizedSale[] = [];
    const errors: string[] = [];

    for (const [market, config] of targets) {
      for (const sourceMarket of config.phygitalsMarkets ?? []) {
        try {
          const url = new URL(env.PHYGITALS_API_URL);
          if (sourceMarket !== "default") url.searchParams.set("market", sourceMarket);
          url.searchParams.set("from", params.from.toISOString());
          url.searchParams.set("to", params.to.toISOString());
          const headers: Record<string, string> = { accept: "application/json" };
          if (env.PHYGITALS_API_KEY) headers.Authorization = `Bearer ${env.PHYGITALS_API_KEY}`;
          const payload = await fetchJson(url.toString(), { headers });
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
