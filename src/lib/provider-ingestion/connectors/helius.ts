import { getIngestionEnv } from "../config";
import type { NormalizedSale, ProviderSalesStatus } from "../types";
import { nowStatus } from "../utils";

export class HeliusSalesValidator {
  private status: ProviderSalesStatus = nowStatus("helius", "needs_api_key", "HELIUS_API_KEY is not configured. Sales remain unverified.");

  getStatus() {
    if (getIngestionEnv().HELIUS_API_KEY && this.status.status === "needs_api_key") {
      return nowStatus("helius", "live", "HELIUS_API_KEY is configured. Transaction verification hook is ready.");
    }
    return this.status;
  }

  async validateSales(sales: NormalizedSale[]): Promise<NormalizedSale[]> {
    const env = getIngestionEnv();
    if (!env.HELIUS_API_KEY) {
      this.status = nowStatus("helius", "needs_api_key", "HELIUS_API_KEY is not configured. Sales remain unverified.");
      return sales.map((sale) => ({ ...sale, validationStatus: "unverified" }));
    }

    // Validation is prepared but intentionally conservative: when enabled, only sales with tx hashes are candidates.
    // A later step can enrich this with full parsed transaction checks without blocking provider ingestion.
    const validated = sales.map((sale) => ({ ...sale, validationStatus: sale.txHash ? "unverified" as const : "failed" as const }));
    this.status = nowStatus("helius", "live", "HELIUS_API_KEY is configured. Transaction verification hook is ready.", validated.length);
    return validated;
  }
}
