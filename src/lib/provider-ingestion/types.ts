export type ProviderId = "magic-eden" | "tensor" | "phygitals" | "collector-crypt";

export type ProviderStatusCode = "live" | "unavailable" | "disabled" | "needs_api_key" | "needs_endpoint" | "error";
export type ValidationStatus = "unverified" | "verified" | "failed";

export type NormalizedSale = {
  provider: ProviderId;
  market: string;
  assetName: string;
  assetMint?: string;
  imageUrl?: string;
  txHash?: string;
  buyerWallet?: string;
  sellerWallet?: string;
  priceSol?: number | null;
  priceUsd?: number | null;
  currency: string;
  timestamp: string;
  blockSlot?: number | null;
  rawPayload: unknown;
  validationStatus: ValidationStatus;
};

export type ProviderSalesStatus = {
  providerId: ProviderId | "helius";
  status: ProviderStatusCode;
  live: boolean;
  message: string;
  checkedAt: string;
  salesFetched?: number;
};

export type MarketSourceConfig = {
  magicEdenSymbols?: string[];
  tensorCollections?: string[];
  phygitalsMarkets?: string[];
  collectorCryptMarkets?: string[];
};

export type FetchSalesParams = {
  from: Date;
  to: Date;
  markets: Record<string, MarketSourceConfig>;
  limit?: number;
};

export interface ProviderSalesConnector {
  providerId: ProviderId;
  fetchSales(params: FetchSalesParams): Promise<NormalizedSale[]>;
  getStatus(): ProviderSalesStatus;
}

export type ProviderSalesDb = {
  updatedAt?: string;
  sales: NormalizedSale[];
  providerStatus: ProviderSalesStatus[];
};
