import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/nfts/status")({
  server: {
    handlers: {
      GET: async () => {
        const [{ readNftDb }, { getAllowedNftCollections }, { nftDatabasePath }, { nftDbExtendedStats }, { readNftScannerConfig }, { getProviderScanStatuses }] = await Promise.all([
          import("@/services/nftStore"),
          import("@/services/trackedNftsConfig"),
          import("@/services/nftSqliteDb"),
          import("@/services/nftCollectionIngestionService"),
          import("@/services/nftScannerConfig"),
          import("@/services/nftScannerStatusService"),
        ]);
        const db = await readNftDb();
        const allowedCollections = getAllowedNftCollections();
        const scannerConfig = readNftScannerConfig();
        const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
        const stats = nftDbExtendedStats();
        return Response.json({
          heliusConfigured: Boolean(env.HELIUS_API_KEY),
          trackedCount: db.tracked_nfts.length,
          activeTrackedCount: db.tracked_nfts.filter((nft) => nft.active).length,
          fetchedAssetCount: db.nft_assets.length,
          allowedCollectionCount: allowedCollections.length,
          allowedCollections,
          queue: db.queue_state,
          ingestion: {
            running: Boolean(db.queue_state.ingestionRunning),
            currentCollection: db.queue_state.ingestionCurrentCollection ?? null,
            currentPage: db.queue_state.ingestionCurrentPage ?? null,
            totalInserted: Number(db.queue_state.ingestionInserted ?? 0),
            totalUpdated: Number(db.queue_state.ingestionUpdated ?? 0),
            totalDuplicatesSkipped: Number(db.queue_state.ingestionDuplicatesSkipped ?? 0),
            lastError: db.queue_state.ingestionLastError ?? null,
            categoryCounts: stats.categoryCounts,
            assetTypeCounts: stats.assetTypeCounts,
            publicGroupCounts: stats.publicGroupCounts,
            cardCount: stats.cardCount,
            otherCount: stats.otherCount,
            unknownCategoryCount: stats.unknownCount,
            stagingCount: stats.stagingCount,
            visiblePublicNftCount: stats.visiblePublicNftCount,
            hiddenOtherNftCount: stats.hiddenOtherNftCount,
            latestIngestionReportPath: db.queue_state.latestIngestionReportPath ?? stats.latestIngestionReportPath,
            latestUniverseComparisonReportPath: db.queue_state.latestUniverseComparisonReportPath ?? stats.latestUniverseComparisonReportPath,
          },
          scanner: {
            dryRun: scannerConfig.dryRun,
            enabled: scannerConfig.enabled,
            batchSize: scannerConfig.batchSize,
            intervalSeconds: scannerConfig.intervalSeconds,
            maxRetries: scannerConfig.maxRetries,
            newMintDiscoveryEnabled: scannerConfig.newMintDiscoveryEnabled,
            newMintDiscoveryIntervalSeconds: scannerConfig.newMintDiscoveryIntervalSeconds,
            newMintDiscoveryLimitPerCollection: scannerConfig.newMintDiscoveryLimitPerCollection,
            scanStatuses: getProviderScanStatuses(),
          },
          database: {
            ok: true,
            path: nftDatabasePath(),
            status: "ready",
            persistenceMode: "sqlite",
          },
        }, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
