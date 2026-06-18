export type RwaNftMarketEventType =
  | "LISTED"
  | "SALE"
  | "DELISTED"
  | "BID"
  | "PRICE_UPDATED"
  | "TRANSFER"
  | "OWNER_CHANGED";

export type RwaNftMarketEventSource =
  | "helius_webhook"
  | "helius_enhanced_tx"
  | "magiceden"
  | "tensor"
  | "discord"
  | "manual"
  | "collector-crypt-verification";

export type NFTMarketStatus =
  | "owned"
  | "unlisted"
  | "listed"
  | "sold"
  | "transferred_out"
  | "recently_sold"
  | "stale"
  | "unknown";

export type NFTMarketValidationStatus = "unverified" | "verified" | "failed";
export type NFTMetadataStatus = "complete" | "partial" | "missing" | "error";
export type NFTLastActivityType =
  | "minted"
  | "listed"
  | "make_offer"
  | "bid"
  | "delisted"
  | "bought"
  | "sold"
  | "transferred"
  | "pack_opened"
  | "unknown";

export type NFTMarketActivityType = "listed" | "make_offer" | "bid" | "sold" | "delisted" | "transfer" | "minted" | "unknown";

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
  id?: string;
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

export type NFTAsset = {
  id: string;
  assetMint: string;
  assetName: string | null;
  imageUrl: string | null;
  market: string | null;
  collectionSlug: string | null;
  collectionName: string | null;
  ownerWallet: string | null;
  metadataUri: string | null;
  sourceProvider: string | null;
  discoveredAt: string | null;
  lastSeenAt: string | null;
  currentStatus: NFTMarketStatus;
  latestMarketPriceSol: number | null;
  latestMarketPriceUsd: number | null;
  latestSalePriceSol: number | null;
  latestSalePriceUsd: number | null;
  latestListingPriceSol: number | null;
  latestListingPriceUsd: number | null;
  latestProvider: string | null;
  latestMarketplace: string | null;
  latestTxHash: string | null;
  lastListedAt: string | null;
  lastSoldAt: string | null;
  lastCheckedAt: string | null;
  currentState?: NFTMarketStatus;
  lastActivityType?: NFTLastActivityType;
  lastActivityAt?: string | null;
  lastActivityTxHash?: string | null;
  lastActivityProvider?: string | null;
  metadataStatus?: NFTMetadataStatus;
  createdAt: string;
  updatedAt: string;
};

export interface ProviderMarketActivityConnector {
  providerId: string;
  fetchActivityForNFT(assetMint: string): Promise<NFTMarketActivity[]>;
  fetchLatestSaleForNFT(assetMint: string): Promise<RwaNftMarketEvent | null>;
  fetchActiveListingForNFT(assetMint: string): Promise<NFTListingState | null>;
}

export type DiscoveredNFTMint = {
  assetMint: string;
  assetName: string | null;
  imageUrl: string | null;
  market: string | null;
  collectionSlug: string | null;
  collectionName: string | null;
  ownerWallet: string | null;
  metadataUri: string | null;
  sourceProvider: string;
  rawPayload: unknown;
};

export interface ProviderMintDiscoveryConnector {
  providerId: string;
  discoverMints(params: {
    collectionSlug: string;
    market: string;
    limit?: number;
    cursor?: string;
  }): Promise<DiscoveredNFTMint[]>;
}

export type ProviderScanStatus = {
  provider: string;
  scanType: "market_state" | "new_mints" | "sales" | "listings";
  status: "live" | "unavailable" | "needs_api_key" | "needs_endpoint" | "needs_chain_ids" | "error";
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  itemsChecked: number;
  itemsFound: number;
  itemsStored: number;
  durationMs: number;
  metadataUpdated?: number;
  imagesUpdated?: number;
  ownersUpdated?: number;
  lastActivitiesUpdated?: number;
};

export type NFTMarketState = {
  nftId: string;
  assetMint: string;
  assetName: string | null;
  market: string | null;
  collectionSlug: string | null;
  collectionName?: string | null;
  imageUrl: string | null;
  currentStatus: NFTMarketStatus;
  currentState?: NFTMarketStatus;
  isListed: boolean;
  isSold: boolean;
  lastActivityType?: NFTLastActivityType;
  lastActivityAt?: string | null;
  lastActivityTxHash?: string | null;
  lastActivityProvider?: string | null;
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
  metadataStatus?: NFTMetadataStatus;
  validationStatus: NFTMarketValidationStatus;
  rawPayload: unknown;
  rawProviderPayloads?: unknown[];
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
