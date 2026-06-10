import { defaultWindow, readMarketSources } from "./config";
import { createSalesConnectors } from "./connectors";
import { HeliusSalesValidator } from "./connectors/helius";
import { getProviderStatuses, upsertProviderSales } from "./store";
import type { NormalizedSale, ProviderId, ProviderSalesStatus } from "./types";
import { nowStatus } from "./utils";

export type RunProviderSalesIngestionOptions = {
  provider?: ProviderId;
  from?: Date;
  to?: Date;
  limit?: number;
};

export type ProviderSalesIngestionResult = {
  from: string;
  to: string;
  fetched: number;
  inserted: number;
  total: number;
  statuses: ProviderSalesStatus[];
};

export async function runProviderSalesIngestion(options: RunProviderSalesIngestionOptions = {}): Promise<ProviderSalesIngestionResult> {
  const window = defaultWindow(7);
  const from = options.from ?? window.from;
  const to = options.to ?? window.to;
  const markets = readMarketSources();
  const connectors = createSalesConnectors().filter((connector) => !options.provider || connector.providerId === options.provider);

  const fetchedSales: NormalizedSale[] = [];
  const statuses: ProviderSalesStatus[] = [];

  for (const connector of connectors) {
    try {
      const sales = await connector.fetchSales({ from, to, markets, limit: options.limit ?? 500 });
      fetchedSales.push(...sales);
      statuses.push(connector.getStatus());
    } catch (error) {
      statuses.push(nowStatus(connector.providerId, "error", error instanceof Error ? error.message : "Provider ingestion failed.", 0));
    }
  }

  const validator = new HeliusSalesValidator();
  const validatedSales = await validator.validateSales(fetchedSales);
  statuses.push(validator.getStatus());

  const { inserted, total } = await upsertProviderSales(validatedSales, statuses);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    fetched: validatedSales.length,
    inserted,
    total,
    statuses,
  };
}

export async function getProviderStatusReport(): Promise<{ providers: ProviderSalesStatus[] }> {
  const storedStatuses = await getProviderStatuses();
  const byProvider = new Map<string, ProviderSalesStatus>();

  for (const status of storedStatuses) byProvider.set(status.providerId, status);
  for (const connector of createSalesConnectors()) {
    byProvider.set(connector.providerId, connector.getStatus());
  }
  byProvider.set("helius", new HeliusSalesValidator().getStatus());

  return { providers: Array.from(byProvider.values()) };
}
