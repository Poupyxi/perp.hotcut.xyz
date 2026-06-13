import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/providers/status")({
  server: {
    handlers: {
      GET: async () => {
        const { getProviderStatusReport } = await import("@/lib/provider-ingestion/ingest");
        const { getMarketActivityProviderStatusReport } = await import("@/services/nftMarketActivityConnectors");
        const { getMintDiscoveryProviderStatusReport } = await import("@/services/nftMintDiscoveryConnectors");
        const { readNftScannerConfig, providerApiEnv } = await import("@/services/nftScannerConfig");
        const { getProviderScanStatuses } = await import("@/services/nftScannerStatusService");
        const salesProviders = await getProviderStatusReport();
        const scannerConfig = readNftScannerConfig();
        return Response.json(
          {
            ...salesProviders,
            ...getMarketActivityProviderStatusReport(),
            ...getMintDiscoveryProviderStatusReport(),
            scanner: {
              dryRun: scannerConfig.dryRun,
              enabled: scannerConfig.enabled,
              batchSize: scannerConfig.batchSize,
              intervalSeconds: scannerConfig.intervalSeconds,
              maxRetries: scannerConfig.maxRetries,
              newMintDiscoveryEnabled: scannerConfig.newMintDiscoveryEnabled,
              newMintDiscoveryLimitPerCollection: scannerConfig.newMintDiscoveryLimitPerCollection,
              trackedCollections: scannerConfig.trackedCollections,
              providerConfig: providerApiEnv(),
              scanStatuses: getProviderScanStatuses(),
            },
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    },
  },
});
