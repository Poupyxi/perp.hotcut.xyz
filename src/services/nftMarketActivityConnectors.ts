import type {
  NFTListingState,
  NFTMarketActivity,
  ProviderMarketActivityConnector,
  RwaNftMarketEvent,
} from "@/types/rwaNftMarket";
import { getSolscanProbe, probeSolscan } from "./solscanNftActivityService";

const solscanProbeCacheRef = getSolscanProbe;

type RuntimeEnv = Record<string, string | undefined>;

export type MarketActivityProviderStatusCode =
  | "live"
  | "disabled"
  | "prepared"
  | "unavailable"
  | "needs_api_key"
  | "needs_endpoint"
  | "needs_chain_ids"
  | "error";

export type MarketActivityProviderStatus = {
  providerId: string;
  status: MarketActivityProviderStatusCode;
  live: boolean;
  message: string;
  checkedAt: string;
};

function env(): RuntimeEnv {
  return (globalThis as unknown as { process?: { env?: RuntimeEnv } }).process?.env ?? {};
}

function status(providerId: string, code: MarketActivityProviderStatusCode, message: string): MarketActivityProviderStatus {
  return {
    providerId,
    status: code,
    live: code === "live",
    message,
    checkedAt: new Date().toISOString(),
  };
}

abstract class BaseConnector implements ProviderMarketActivityConnector {
  abstract providerId: string;
  abstract getStatus(): MarketActivityProviderStatus;

  async fetchActivityForNFT(_assetMint: string): Promise<NFTMarketActivity[]> {
    return [];
  }

  async fetchLatestSaleForNFT(_assetMint: string): Promise<RwaNftMarketEvent | null> {
    return null;
  }

  async fetchActiveListingForNFT(_assetMint: string): Promise<NFTListingState | null> {
    return null;
  }
}

class MagicEdenMarketActivityConnector extends BaseConnector {
  providerId = "magic-eden";

  getStatus() {
    const configured = Boolean(env().MAGIC_EDEN_API_KEY || env().MAGIC_EDEN_API_URL) && (env().MAGIC_EDEN_ENABLED ?? "false") === "true";
    return configured
      ? status(this.providerId, "prepared", "Magic Eden is configured, but per-mint activity polling is not enabled until collection/listing endpoints are mapped.")
      : status(this.providerId, "disabled", "Provider not connected.");
  }
}

class TensorMarketActivityConnector extends BaseConnector {
  providerId = "tensor";

  getStatus() {
    return env().TENSOR_API_KEY
      ? status(this.providerId, "prepared", "Tensor API key is configured; connector is ready for endpoint mapping.")
      : status(this.providerId, "needs_api_key", "Tensor requires TENSOR_API_KEY.");
  }
}

class HeliusMarketActivityConnector extends BaseConnector {
  providerId = "helius";

  getStatus() {
    return env().HELIUS_API_KEY
      ? status(this.providerId, "live", "Helius is configured for transaction validation and metadata enrichment.")
      : status(this.providerId, "needs_api_key", "Helius requires HELIUS_API_KEY.");
  }
}

class SolscanMarketActivityConnector extends BaseConnector {
  providerId = "solscan";

  getStatus() {
    if ((env().SOLSCAN_ENABLED ?? "true").toLowerCase() === "false") {
      return status(this.providerId, "disabled", "Solscan disabled via SOLSCAN_ENABLED=false.");
    }
    if (!env().SOLSCAN_API_KEY) {
      return status(this.providerId, "needs_api_key", "Solscan requires SOLSCAN_API_KEY for reliable API usage.");
    }
    const probe = solscanProbeCacheRef();
    if (!probe) {
      return status(this.providerId, "prepared", "Solscan API key configured. Live probe pending — call /api/providers/status again in a moment.");
    }
    if (probe.ok) {
      return status(this.providerId, "live", "Solscan Pro endpoints reachable. Activity + transaction-detail enrichment active.");
    }
    if (probe.httpStatus === 401 || probe.httpStatus === 403) {
      return status(
        this.providerId,
        "error",
        `Solscan rejected the API key (${probe.message}). Upgrade your Solscan Pro plan to access /account/transactions and /nft/activities — further calls are short-circuited.`,
      );
    }
    if (probe.httpStatus === 429) {
      return status(this.providerId, "unavailable", `Solscan rate-limited: ${probe.message}.`);
    }
    return status(this.providerId, "error", `Solscan probe failed: ${probe.message}`);
  }
}

class PhygitalsMarketActivityConnector extends BaseConnector {
  providerId = "phygitals";

  getStatus() {
    return (env().PHYGITALS_ENABLED ?? "false") === "true" && env().PHYGITALS_API_URL
      ? status(this.providerId, "prepared", "Phygitals endpoint is configured; sale/listing mapping can be enabled once response fields are confirmed.")
      : status(this.providerId, "disabled", "Provider not connected.");
  }
}

class CollectorCryptMarketActivityConnector extends BaseConnector {
  providerId = "collector-crypt";

  getStatus() {
    return (env().COLLECTOR_CRYPT_ENABLED ?? "false") === "true" && env().COLLECTOR_CRYPT_API_URL
      ? status(this.providerId, "prepared", "Collector Crypt endpoint is configured; only sales/fills endpoints should be used as verified sales.")
      : status(this.providerId, "disabled", "Provider not connected.");
  }
}

class BeezieMarketActivityConnector extends BaseConnector {
  providerId = "beezie";

  getStatus() {
    return env().BEEZIE_CHAIN_IDS || env().BEEZIE_PROGRAM_IDS
      ? status(this.providerId, "prepared", "Beezie chain/program identifiers are configured; connector is ready for endpoint mapping.")
      : status(this.providerId, "needs_chain_ids", "Beezie needs chain IDs or program IDs before NFT activity can be tracked.");
  }
}

export function createMarketActivityConnectors(): Array<ProviderMarketActivityConnector & { getStatus(): MarketActivityProviderStatus }> {
  return [
    new MagicEdenMarketActivityConnector(),
    new TensorMarketActivityConnector(),
    new HeliusMarketActivityConnector(),
    new SolscanMarketActivityConnector(),
    new PhygitalsMarketActivityConnector(),
    new CollectorCryptMarketActivityConnector(),
    new BeezieMarketActivityConnector(),
  ];
}

export function getMarketActivityProviderStatusReport() {
  return {
    marketActivityProviders: createMarketActivityConnectors().map((connector) => connector.getStatus()),
  };
}
