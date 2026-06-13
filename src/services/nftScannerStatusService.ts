import type { ProviderScanStatus } from "@/types/rwaNftMarket";
import { getNftDb } from "./nftSqliteDb";
import { isNftScannerDryRun } from "./nftScannerConfig";

type ProviderScanStatusInput = Omit<ProviderScanStatus, "lastRunAt" | "lastSuccessAt"> & {
  lastRunAt?: string | null;
  lastSuccessAt?: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

function rowToStatus(row: Record<string, unknown>): ProviderScanStatus {
  return {
    provider: String(row.provider ?? ""),
    scanType: String(row.scan_type ?? "market_state") as ProviderScanStatus["scanType"],
    status: String(row.status ?? "unavailable") as ProviderScanStatus["status"],
    lastRunAt: typeof row.last_run_at === "string" ? row.last_run_at : null,
    lastSuccessAt: typeof row.last_success_at === "string" ? row.last_success_at : null,
    lastError: typeof row.last_error === "string" ? row.last_error : null,
    itemsChecked: Number(row.items_checked ?? 0),
    itemsFound: Number(row.items_found ?? 0),
    itemsStored: Number(row.items_stored ?? 0),
    durationMs: Number(row.duration_ms ?? 0),
    metadataUpdated: Number(row.metadata_updated ?? 0),
    imagesUpdated: Number(row.images_updated ?? 0),
    ownersUpdated: Number(row.owners_updated ?? 0),
    lastActivitiesUpdated: Number(row.last_activities_updated ?? 0),
  };
}

export function saveProviderScanStatus(status: ProviderScanStatusInput, options: { dryRun?: boolean | null } = {}) {
  const dryRun = isNftScannerDryRun(options.dryRun);
  const timestamp = nowIso();
  const lastRunAt = status.lastRunAt ?? timestamp;
  const lastSuccessAt = status.status === "live" || status.status === "unavailable" ? status.lastSuccessAt ?? timestamp : status.lastSuccessAt ?? null;

  if (dryRun) {
    console.log(`[NFT SCANNER][DRY RUN] Provider status would be saved: ${status.provider}/${status.scanType} ${status.status}`);
    return;
  }

  getNftDb().prepare(`
    INSERT INTO provider_scan_status (
      provider, scan_type, status, last_run_at, last_success_at, last_error,
      items_checked, items_found, items_stored, duration_ms,
      metadata_updated, images_updated, owners_updated, last_activities_updated,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, scan_type) DO UPDATE SET
      status = excluded.status,
      last_run_at = excluded.last_run_at,
      last_success_at = excluded.last_success_at,
      last_error = excluded.last_error,
      items_checked = excluded.items_checked,
      items_found = excluded.items_found,
      items_stored = excluded.items_stored,
      duration_ms = excluded.duration_ms,
      metadata_updated = excluded.metadata_updated,
      images_updated = excluded.images_updated,
      owners_updated = excluded.owners_updated,
      last_activities_updated = excluded.last_activities_updated,
      updated_at = excluded.updated_at
  `).run(
    status.provider,
    status.scanType,
    status.status,
    lastRunAt,
    lastSuccessAt,
    status.lastError,
    status.itemsChecked,
    status.itemsFound,
    status.itemsStored,
    status.durationMs,
    status.metadataUpdated ?? 0,
    status.imagesUpdated ?? 0,
    status.ownersUpdated ?? 0,
    status.lastActivitiesUpdated ?? 0,
    timestamp,
  );
}

export function getProviderScanStatuses(): ProviderScanStatus[] {
  const rows = getNftDb().prepare(`
    SELECT *
    FROM provider_scan_status
    ORDER BY updated_at DESC, provider ASC, scan_type ASC
  `).all() as Array<Record<string, unknown>>;

  return rows.map(rowToStatus);
}
