export type RwaNftMarketEventType =
  | "LISTED"
  | "SALE"
  | "DELISTED"
  | "PRICE_UPDATED"
  | "TRANSFER"
  | "OWNER_CHANGED";

export type RwaNftMarketEventSource =
  | "helius_webhook"
  | "helius_enhanced_tx"
  | "magiceden"
  | "tensor"
  | "discord"
  | "manual";

export type NFTMarketStatus =
  | "unlisted"
  | "listed"
  | "sold"
  | "recently_sold"
  | "stale"
  | "unknown";

export type NFTMarketValidationStatus = "unverified" | "verified" | "failed";

export type NFTMarketActivityType = "listed" | "sold" | "delisted" | "transfer" | "unknown";

export type NFTMarketActivity = {
  provider: string;
  marketplace: string | null;
  assetMint: string;
  activityType: NFTMarketActivityType;
  priceSol: number | null;
  priceUsd: number | null;
  buyerWallet: string | null;
  sellerWallet: string | null;
  txHash: string | null;
  timestamp: string | null;
  blockSlot: number | null;
  rawPayload: unknown;
};

export type NFTListingState = {
  assetMint: string;
  provider: string;
  marketplace: string | null;
  listingId: string | null;
  sellerWallet: string | null;
  priceSol: number | null;
  priceUsd: number | null;
  currency: string | null;
  isActive: boolean;
  listedAt: string | null;
  lastSeenAt: string | null;
  rawPayload: unknown;
};

export interface ProviderMarketActivityConnector {
  providerId: string;
  fetchActivityForNFT(assetMint: string): Promise<NFTMarketActivity[]>;
  fetchLatestSaleForNFT(assetMint: string): Promise<RwaNftMarketEvent | null>;
  fetchActiveListingForNFT(assetMint: string): Promise<NFTListingState | null>;
}

export type NFTMarketState = {
  nftId: string;
  assetMint: string;
  assetName: string | null;
  market: string | null;
  collectionSlug: string | null;
  imageUrl: string | null;
  currentStatus: NFTMarketStatus;
  isListed: boolean;
  isSold: boolean;
  latestListingPriceSol: number | null;
  latestListingPriceUsd: number | null;
  latestSalePriceSol: number | null;
  latestSalePriceUsd: number | null;
  latestPurchasePriceSol: number | null;
  latestPurchasePriceUsd: number | null;
  latestMarketPriceSol: number | null;
  latestMarketPriceUsd: number | null;
  latestMarketplace: string | null;
  latestProvider: string | null;
  latestTxHash: string | null;
  buyerWallet: string | null;
  sellerWallet: string | null;
  lastListedAt: string | null;
  lastSoldAt: string | null;
  lastCheckedAt: string | null;
  validationStatus: NFTMarketValidationStatus;
  rawPayload: unknown;
};

export type RwaNftCategory =
  | "pokemon"
  | "one_piece"
  | "basketball"
  | "football"
  | "hockey"
  | "baseball"
  | "soccer"
  | "yugioh"
  | "dragon_ball"
  | "magic_the_gathering"
  | "unknown";

export type RwaNftMarketEvent = {
  mint: string;
  category: string | null;
  eventType: RwaNftMarketEventType;
  priceSol: number | null;
  priceUsd: number | null;
  paymentMint?: string | null;
  paymentSymbol?: string | null;
  paymentAmount?: number | null;
  marketplace: string | null;
  txSignature: string | null;
  buyer: string | null;
  seller: string | null;
  owner: string | null;
  eventAt: string;
  source: RwaNftMarketEventSource;
  rawPayload: unknown;
};

export type VerifiedSale = {
  id: string;
  mint: string;
  category: string;
  priceSol: number | null;
  priceUsd: number | null;
  paymentMint: string | null;
  paymentSymbol: string | null;
  paymentAmount: number | null;
  previousSaleAmount: number | null;
  previousSaleSymbol: string | null;
  previousSaleTxSignature: string | null;
  priceChangeAmount: number | null;
  priceChangePercent: number | null;
  priceChangeDirection: "up" | "down" | "flat" | "unknown" | null;
  marketplace: string | null;
  txSignature: string;
  buyer: string | null;
  seller: string | null;
  eventAt: string;
  source: RwaNftMarketEventSource;
  fallbackVerified: boolean;
  isTestSale: boolean;
  name: string | null;
  image: string | null;
  collection: string | null;
  owner: string | null;
  currentStatus: NFTMarketStatus | null;
  isListed: boolean;
  latestListingPriceSol: number | null;
  latestListingPriceUsd: number | null;
  latestPurchasePriceSol: number | null;
  latestPurchasePriceUsd: number | null;
  latestMarketPriceSol: number | null;
  latestMarketPriceUsd: number | null;
  latestMarketplace: string | null;
  latestProvider: string | null;
  latestTxHash: string | null;
  lastCheckedAt: string | null;
  validationStatus: NFTMarketValidationStatus | null;
  lastSalePriceSol: number | null;
  lastSalePriceUsd: number | null;
  lastSaleAt: string | null;
  lastSaleMarketplace: string | null;
};
