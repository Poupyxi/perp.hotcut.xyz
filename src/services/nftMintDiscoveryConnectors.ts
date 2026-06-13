import type { DiscoveredNFTMint, ProviderMintDiscoveryConnector } from "@/types/rwaNftMarket";
import { heliusAssetsPage } from "./nftCollectionIngestionService";
import { providerApiEnv } from "./nftScannerConfig";

type RuntimeEnv = Record<string, string | undefined>;

export type MintDiscoveryProviderStatusCode =
  | "live"
  | "prepared"
  | "unavailable"
  | "needs_api_key"
  | "needs_endpoint"
  | "needs_chain_ids"
  | "error";

export type MintDiscoveryProviderStatus = {
  providerId: string;
  status: MintDiscoveryProviderStatusCode;
  live: boolean;
  message: string;
  checkedAt: string;
};

function env(): RuntimeEnv {
  return (globalThis as unknown as { process?: { env?: RuntimeEnv } }).process?.env ?? {};
}

function status(providerId: string, code: MintDiscoveryProviderStatusCode, message: string): MintDiscoveryProviderStatus {
  return {
    providerId,
    status: code,
    live: code === "live",
    message,
    checkedAt: new Date().toISOString(),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function mapHeliusAsset(raw: unknown, params: { collectionSlug: string; market: string }): DiscoveredNFTMint | null {
  const record = asRecord(raw);
  const content = asRecord(record.content);
  const metadata = asRecord(content.metadata);
  const links = asRecord(content.links);
  const ownership = asRecord(record.ownership);
  const mint = asString(record.id);
  if (!mint) return null;

  return {
    assetMint: mint,
    assetName: asString(metadata.name),
    imageUrl: asString(links.image),
    market: params.market,
    collectionSlug: params.collectionSlug,
    collectionName: asString(metadata.collection) ?? params.collectionSlug,
    ownerWallet: asString(ownership.owner),
    metadataUri: asString(content.json_uri),
    sourceProvider: "helius",
    rawPayload: raw,
  };
}

abstract class BaseMintDiscoveryConnector implements ProviderMintDiscoveryConnector {
  abstract providerId: string;
  abstract getStatus(): MintDiscoveryProviderStatus;

  async discoverMints(_params: { collectionSlug: string; market: string; limit?: number; cursor?: string }): Promise<DiscoveredNFTMint[]> {
    return [];
  }
}

class HeliusMintDiscoveryConnector extends BaseMintDiscoveryConnector {
  providerId = "helius";

  getStatus() {
    return env().HELIUS_API_KEY
      ? status(this.providerId, "live", "Helius DAS is configured for allowlisted collection mint discovery.")
      : status(this.providerId, "needs_api_key", "Helius discovery requires HELIUS_API_KEY.");
  }

  async discoverMints(params: { collectionSlug: string; market: string; limit?: number; cursor?: string }): Promise<DiscoveredNFTMint[]> {
    if (!env().HELIUS_API_KEY) return [];
    const limit = Math.min(Math.max(Math.trunc(params.limit ?? 500), 1), 1000);
    const page = params.cursor ? Math.max(Number(params.cursor), 1) : 1;
    const result = await heliusAssetsPage(params.collectionSlug, page, limit);
    return result.items
      .map((item) => mapHeliusAsset(item, params))
      .filter((item): item is DiscoveredNFTMint => Boolean(item));
  }
}

class MagicEdenMintDiscoveryConnector extends BaseMintDiscoveryConnector {
  providerId = "magic-eden";

  getStatus() {
    return providerApiEnv().magicEdenConfigured
      ? status(this.providerId, "prepared", "Magic Eden is configured; collection symbol discovery endpoint mapping is still required.")
      : status(this.providerId, "needs_endpoint", "Magic Eden discovery needs configured collection symbols and public API endpoint mapping.");
  }
}

class TensorMintDiscoveryConnector extends BaseMintDiscoveryConnector {
  providerId = "tensor";

  getStatus() {
    return env().TENSOR_API_KEY
      ? status(this.providerId, "prepared", "Tensor API key is configured; mint discovery endpoint mapping is still required.")
      : status(this.providerId, "needs_api_key", "Tensor discovery requires TENSOR_API_KEY.");
  }
}

class PhygitalsMintDiscoveryConnector extends BaseMintDiscoveryConnector {
  providerId = "phygitals";

  getStatus() {
    return env().PHYGITALS_API_URL
      ? status(this.providerId, "prepared", "Phygitals endpoint is configured; public response mapping is still required.")
      : status(this.providerId, "needs_endpoint", "Phygitals discovery requires PHYGITALS_API_URL.");
  }
}

class CollectorCryptMintDiscoveryConnector extends BaseMintDiscoveryConnector {
  providerId = "collector-crypt";

  getStatus() {
    return env().COLLECTOR_CRYPT_API_URL
      ? status(this.providerId, "prepared", "Collector Crypt endpoint is configured; use only official/public mint endpoints.")
      : status(this.providerId, "needs_endpoint", "Collector Crypt discovery requires an official public endpoint or allowlisted on-chain collection IDs.");
  }
}

class BeezieMintDiscoveryConnector extends BaseMintDiscoveryConnector {
  providerId = "beezie";

  getStatus() {
    return env().BEEZIE_COLLECTION_IDS || env().BEEZIE_CHAIN_IDS || env().BEEZIE_PROGRAM_IDS
      ? status(this.providerId, "prepared", "Beezie identifiers are configured; public endpoint mapping is still required.")
      : status(this.providerId, "needs_chain_ids", "Beezie discovery requires collection IDs, chain IDs, or program IDs.");
  }
}

export function createMintDiscoveryConnectors(): Array<ProviderMintDiscoveryConnector & { getStatus(): MintDiscoveryProviderStatus }> {
  return [
    new MagicEdenMintDiscoveryConnector(),
    new HeliusMintDiscoveryConnector(),
    new TensorMintDiscoveryConnector(),
    new PhygitalsMintDiscoveryConnector(),
    new CollectorCryptMintDiscoveryConnector(),
    new BeezieMintDiscoveryConnector(),
  ];
}

export function getMintDiscoveryProviderStatusReport() {
  return {
    mintDiscoveryProviders: createMintDiscoveryConnectors().map((connector) => connector.getStatus()),
  };
}
