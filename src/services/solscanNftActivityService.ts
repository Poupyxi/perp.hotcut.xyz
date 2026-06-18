type RuntimeEnv = Record<string, string | undefined>;

export type NftActivityProviderId = "solscan" | "helius" | "cache";
export type NftActivityProviderStatus = "ok" | "incomplete" | "error" | "unavailable" | "rate_limited" | "stale";

export type NormalizedProviderActivity = Record<string, unknown>;

export type NftActivityProviderResult = {
  provider: NftActivityProviderId;
  status: NftActivityProviderStatus;
  activities: NormalizedProviderActivity[];
  fallbackUsed: boolean;
  dbCacheUsed: boolean;
  error: string | null;
  endpointsUsed: string[];
  fieldProviders: Record<string, string>;
};

const DEFAULT_SOLSCAN_API_URL = "https://pro-api.solscan.io/v2.0";

function env(): RuntimeEnv {
  return (globalThis as unknown as { process?: { env?: RuntimeEnv } }).process?.env ?? {};
}

export type SolscanProbeResult = {
  ok: boolean;
  disabled: boolean;
  httpStatus: number;
  message: string;
  checkedAt: number;
};

const PROBE_TTL_MS = 30 * 60_000;
const PROBE_RETRY_AFTER_AUTH_ERROR_MS = 10 * 60_000;
let probeCache: SolscanProbeResult | null = null;
let probeInFlight: Promise<SolscanProbeResult> | null = null;

export function getSolscanProbe(): SolscanProbeResult | null {
  return probeCache;
}

export function isSolscanDisabled(): boolean {
  if ((env().SOLSCAN_ENABLED ?? "true").toLowerCase() === "false") return true;
  if (!env().SOLSCAN_API_KEY) return true;
  if (probeCache && probeCache.disabled) {
    const auth = probeCache.httpStatus === 401 || probeCache.httpStatus === 403;
    const ttl = auth ? PROBE_RETRY_AFTER_AUTH_ERROR_MS : PROBE_TTL_MS;
    if (Date.now() - probeCache.checkedAt < ttl) return true;
  }
  return false;
}

export async function probeSolscan(force = false): Promise<SolscanProbeResult> {
  const now = Date.now();
  if (!force && probeCache && now - probeCache.checkedAt < PROBE_TTL_MS) {
    return probeCache;
  }
  if (probeInFlight) return probeInFlight;

  probeInFlight = (async () => {
    try {
      if ((env().SOLSCAN_ENABLED ?? "true").toLowerCase() === "false") {
        return (probeCache = {
          ok: false,
          disabled: true,
          httpStatus: 0,
          message: "Disabled via SOLSCAN_ENABLED=false",
          checkedAt: Date.now(),
        });
      }
      const key = env().SOLSCAN_API_KEY?.trim();
      if (!key) {
        return (probeCache = {
          ok: false,
          disabled: true,
          httpStatus: 0,
          message: "SOLSCAN_API_KEY missing",
          checkedAt: Date.now(),
        });
      }
      const url = (env().SOLSCAN_API_URL || DEFAULT_SOLSCAN_API_URL).replace(/\/+$/, "");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      let httpStatus = 0;
      let message = "";
      try {
        const res = await fetch(
          `${url}/account/transactions?address=So11111111111111111111111111111111111111112&limit=1`,
          { headers: { token: key, Authorization: `Bearer ${key}` }, signal: controller.signal },
        );
        httpStatus = res.status;
        if (res.ok) {
          return (probeCache = {
            ok: true,
            disabled: false,
            httpStatus,
            message: "Solscan Pro endpoints reachable",
            checkedAt: Date.now(),
          });
        }
        try {
          const body = (await res.json()) as { errors?: { message?: string } };
          message = body.errors?.message ? `${httpStatus}: ${body.errors.message}` : `Solscan ${httpStatus}`;
        } catch {
          message = `Solscan ${httpStatus}`;
        }
      } catch (err) {
        message = err instanceof Error ? err.message : "Solscan probe failed";
      } finally {
        clearTimeout(timer);
      }
      const auth = httpStatus === 401 || httpStatus === 403;
      const result: SolscanProbeResult = {
        ok: false,
        disabled: auth,
        httpStatus,
        message,
        checkedAt: Date.now(),
      };
      probeCache = result;
      if (auth) {
        console.warn(`[SOLSCAN] Disabling further calls — ${message}`);
      }
      return result;
    } finally {
      probeInFlight = null;
    }
  })();

  return probeInFlight;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function arrayFromPayload(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.map(asRecord);
  const record = asRecord(payload);
  const candidates = [record.data, record.result, record.items, record.activities, record.transactions, record.transfers];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.map(asRecord);
    const nested = asRecord(candidate);
    if (Array.isArray(nested.items)) return nested.items.map(asRecord);
    if (Array.isArray(nested.data)) return nested.data.map(asRecord);
  }
  return [];
}

function normalizeSignature(row: Record<string, unknown>) {
  return asString(row.trans_id)
    ?? asString(row.tx_hash)
    ?? asString(row.txHash)
    ?? asString(row.signature)
    ?? asString(row.transactionSignature)
    ?? asString(row.tx);
}

function normalizeTimestamp(row: Record<string, unknown>) {
  return numberFromUnknown(row.block_time)
    ?? numberFromUnknown(row.blockTime)
    ?? numberFromUnknown(row.time)
    ?? numberFromUnknown(row.timestamp)
    ?? asString(row.block_time)
    ?? asString(row.blockTime)
    ?? asString(row.time)
    ?? asString(row.timestamp);
}

function normalizeOwnerTransfer(row: Record<string, unknown>, mint: string) {
  const from = asString(row.from_address) ?? asString(row.fromAddress) ?? asString(row.src) ?? asString(row.source);
  const to = asString(row.to_address) ?? asString(row.toAddress) ?? asString(row.dst) ?? asString(row.destination);
  const amount = numberFromUnknown(row.amount) ?? numberFromUnknown(row.lamport);
  const tokenMint = asString(row.token_address) ?? asString(row.tokenAddress) ?? asString(row.mint) ?? mint;
  return {
    mint: tokenMint,
    assetMint: tokenMint,
    fromUserAccount: from,
    fromAddress: from,
    toUserAccount: to,
    toAddress: to,
    tokenAmount: amount,
    amount,
  };
}

function normalizeSolscanRow(row: Record<string, unknown>, mint: string, sourceEndpoint: string): NormalizedProviderActivity {
  const signature = normalizeSignature(row);
  const type = asString(row.activity_type)
    ?? asString(row.type)
    ?? asString(row.tx_type)
    ?? asString(row.transaction_type)
    ?? asString(row.status);
  const source = asString(row.source) ?? asString(row.platform) ?? "solscan";
  const description = asString(row.description)
    ?? asString(row.activity_type)
    ?? asString(row.type)
    ?? sourceEndpoint;
  const ownerTransfer = normalizeOwnerTransfer(row, mint);
  const accounts = [
    asString(row.signer),
    asString(row.owner),
    ownerTransfer.fromUserAccount,
    ownerTransfer.toUserAccount,
    mint,
  ].filter(Boolean).map((account) => ({ account }));

  return {
    ...row,
    signature,
    transactionSignature: signature,
    txHash: signature,
    timestamp: normalizeTimestamp(row),
    type,
    source,
    description,
    events: {
      nft: {
        source: "solscan",
        nfts: [ownerTransfer],
      },
    },
    nftTransfers: [ownerTransfer],
    tokenTransfers: [ownerTransfer],
    nativeTransfers: row.lamport || row.amount ? [ownerTransfer] : [],
    accountData: accounts,
    instructions: Array.isArray(row.parsed_instructions)
      ? row.parsed_instructions
      : Array.isArray(row.instructions)
        ? row.instructions
        : [],
    logs: Array.isArray(row.logs) ? row.logs : [],
    logMessages: Array.isArray(row.log_messages) ? row.log_messages : [],
    provider: "solscan",
    sourceEndpoint,
  };
}

function baseUrl() {
  return (env().SOLSCAN_API_URL || DEFAULT_SOLSCAN_API_URL).replace(/\/+$/, "");
}

function solscanApiKey() {
  return env().SOLSCAN_API_KEY?.trim() || null;
}

function providerLog(input: {
  mint: string;
  requestedDataType: string;
  primaryProvider: string;
  providerCalled: string;
  fallbackUsed: boolean;
  providerStatus: string;
  dbCacheUsed: boolean;
}) {
  console.log(`[NFT PROVIDER] mint=${input.mint} requested=${input.requestedDataType} primary=${input.primaryProvider} called=${input.providerCalled} fallback_used=${input.fallbackUsed} status=${input.providerStatus} db_cache_used=${input.dbCacheUsed}`);
}

async function fetchJson(path: string, mint: string) {
  const key = solscanApiKey();
  if (!key) {
    return { status: "unavailable" as const, payload: null, endpoint: path, error: "Missing SOLSCAN_API_KEY" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        token: key,
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
    });
    if (response.status === 429) return { status: "rate_limited" as const, payload: null, endpoint: path, error: "Solscan 429" };
    if (response.status === 401 || response.status === 403) {
      let detail = `${response.status}`;
      try {
        const body = await response.clone().json() as { errors?: { message?: string } };
        if (body.errors?.message) detail = `${response.status}: ${body.errors.message}`;
      } catch { /* ignore */ }
      probeCache = {
        ok: false,
        disabled: true,
        httpStatus: response.status,
        message: detail,
        checkedAt: Date.now(),
      };
      console.warn(`[SOLSCAN] Disabling further calls — ${detail}`);
      return { status: "error" as const, payload: null, endpoint: path, error: `Solscan ${detail}` };
    }
    if (!response.ok) return { status: "error" as const, payload: null, endpoint: path, error: `Solscan ${response.status}` };
    return { status: "ok" as const, payload: await response.json() as unknown, endpoint: path, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Solscan request failed";
    return { status: "error" as const, payload: null, endpoint: path, error: message.includes("abort") ? "Solscan timeout" : message };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchSolscanNftActivity(mint: string, primaryProvider = "solscan"): Promise<NftActivityProviderResult> {
  if (isSolscanDisabled()) {
    const probe = getSolscanProbe();
    return {
      provider: "solscan",
      status: "unavailable",
      activities: [],
      fallbackUsed: false,
      dbCacheUsed: false,
      error: probe?.message ?? "Solscan disabled",
      endpointsUsed: [],
      fieldProviders: {},
    };
  }

  if (!getSolscanProbe()) {
    const probe = await probeSolscan();
    if (probe.disabled) {
      return {
        provider: "solscan",
        status: "unavailable",
        activities: [],
        fallbackUsed: false,
        dbCacheUsed: false,
        error: probe.message,
        endpointsUsed: [],
        fieldProviders: {},
      };
    }
  }

  const encodedMint = encodeURIComponent(mint);
  const endpoints = [
    `/account/transactions?address=${encodedMint}&limit=8`,
    `/account/transfer?address=${encodedMint}&page=1&page_size=8`,
    `/nft/activities?token_address=${encodedMint}&page=1&page_size=8`,
  ];
  const activities: NormalizedProviderActivity[] = [];
  const endpointsUsed: string[] = [];
  let lastStatus: NftActivityProviderStatus = "unavailable";
  let lastError: string | null = null;
  let latestSignature: string | null = null;

  for (const endpoint of endpoints) {
    const result = await fetchJson(endpoint, mint);
    endpointsUsed.push(endpoint.split("?")[0]);
    lastStatus = result.status;
    lastError = result.error;
    providerLog({
      mint,
      requestedDataType: "activity",
      primaryProvider,
      providerCalled: "solscan",
      fallbackUsed: false,
      providerStatus: result.status,
      dbCacheUsed: false,
    });
    if (result.status === "rate_limited") break;
    if (result.status !== "ok") continue;
    const rows = arrayFromPayload(result.payload);
    const normalizedRows = rows.map((row) => normalizeSolscanRow(row, mint, endpoint.split("?")[0]));
    activities.push(...normalizedRows);
    latestSignature = latestSignature ?? normalizeSignature(normalizedRows[0] ?? {});
    if (latestSignature) {
      const detailEndpoint = `/transaction/detail?tx=${encodeURIComponent(latestSignature)}`;
      const detail = await fetchJson(detailEndpoint, mint);
      endpointsUsed.push("/transaction/detail");
      providerLog({
        mint,
        requestedDataType: "transaction_detail",
        primaryProvider,
        providerCalled: "solscan",
        fallbackUsed: false,
        providerStatus: detail.status,
        dbCacheUsed: false,
      });
      if (detail.status === "ok") {
        const detailRows = arrayFromPayload(detail.payload);
        if (detailRows.length) activities.unshift(normalizeSolscanRow(detailRows[0], mint, "/transaction/detail"));
        else activities.unshift(normalizeSolscanRow(asRecord(detail.payload), mint, "/transaction/detail"));
      }
    }
    if (activities.length > 0) break;
  }

  const deduped = new Map<string, NormalizedProviderActivity>();
  for (const activity of activities) {
    const signature = normalizeSignature(activity) ?? `${deduped.size}`;
    if (!deduped.has(signature)) deduped.set(signature, activity);
  }
  const normalizedActivities = [...deduped.values()];
  const status: NftActivityProviderStatus = normalizedActivities.length > 0 ? "ok" : lastStatus === "ok" ? "incomplete" : lastStatus;
  return {
    provider: "solscan",
    status,
    activities: normalizedActivities,
    fallbackUsed: false,
    dbCacheUsed: false,
    error: normalizedActivities.length > 0 ? null : lastError ?? "Solscan returned no usable activity",
    endpointsUsed,
    fieldProviders: {
      lastActivity: "solscan",
      latestTransaction: "solscan",
      transactionDetail: "solscan",
      accountTransfers: "solscan",
      nftActivities: "solscan",
    },
  };
}

export function getProviderStrategyConfig() {
  return {
    activityPrimaryProvider: (env().NFT_ACTIVITY_PRIMARY_PROVIDER || "solscan").toLowerCase(),
    metadataPrimaryProvider: (env().NFT_METADATA_PRIMARY_PROVIDER || "helius").toLowerCase(),
    fallbackEnabled: (env().PROVIDER_FALLBACK_ENABLED || "true").toLowerCase() !== "false",
    solscanConfigured: Boolean(solscanApiKey()),
    solscanApiUrl: baseUrl(),
  };
}

export function logProviderStrategy(input: Parameters<typeof providerLog>[0]) {
  providerLog(input);
}
