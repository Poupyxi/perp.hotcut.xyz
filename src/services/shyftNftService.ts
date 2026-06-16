type RuntimeEnv = Record<string, string | undefined>;

export type ShyftAssetLookupResult = {
  provider: "shyft";
  status: "ok" | "incomplete" | "unavailable" | "error";
  asset: Record<string, unknown> | null;
  owner: string | null;
  collection: string | null;
  error: string | null;
  endpoint: string | null;
};

const DEFAULT_SHYFT_API_URL = "https://api.shyft.to";
const DEFAULT_NETWORK = "mainnet-beta";
const MAX_COLLECTION_PAGES = 10;

function env(): RuntimeEnv {
  return (globalThis as unknown as { process?: { env?: RuntimeEnv } }).process?.env ?? {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function uniqueRecords(rows: Record<string, unknown>[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = asString(row.mint) ?? asString(row.address) ?? asString(row.token_address) ?? JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function shyftBaseUrl() {
  return (env().SHYFT_API_URL || DEFAULT_SHYFT_API_URL).replace(/\/+$/, "");
}

function shyftApiKey() {
  return env().SHYFT_API_KEY?.trim() || null;
}

async function fetchShyftJson(path: string, searchParams: URLSearchParams): Promise<unknown> {
  const apiKey = shyftApiKey();
  if (!apiKey) throw new Error("Missing SHYFT_API_KEY");
  const url = new URL(`${shyftBaseUrl()}${path}`);
  for (const [key, value] of searchParams.entries()) url.searchParams.set(key, value);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-api-key": apiKey,
      },
      signal: controller.signal,
    });
    if (response.status === 429) throw new Error("Shyft rate limited");
    if (!response.ok) throw new Error(`Shyft ${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function rowsFromShyftPayload(payload: unknown): Record<string, unknown>[] {
  const record = asRecord(payload);
  const result = asRecord(record.result);
  const candidates = [
    result.nfts,
    result.tokens,
    result.items,
    record.result,
    record.nfts,
    record.tokens,
    record.items,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.map(asRecord);
  }
  return [];
}

function normalizeShyftRecord(row: Record<string, unknown>, mint: string, fallbackCollection: string | null): Record<string, unknown> {
  const content = asRecord(row.content);
  const metadata = asRecord(content.metadata);
  const ownership = asRecord(row.ownership);
  const collectionData = asRecord(row.collection_data);
  const mintValue = asString(row.mint) ?? mint;
  const name = asString(row.name) ?? asString(metadata.name) ?? asString(content.name);
  const description = asString(row.description) ?? asString(metadata.description);
  const image = asString(row.image) ?? asString(row.image_url) ?? asString(metadata.image) ?? asString(content.image);
  const owner = asString(row.owner) ?? asString(row.owner_wallet) ?? asString(ownership.owner);
  const collection = asString(collectionData.address) ?? asString(row.collection) ?? fallbackCollection;
  const attributes = asArray(row.attributes).length ? asArray(row.attributes) : asArray(metadata.attributes);

  return {
    id: mintValue,
    content: {
      metadata: {
        name,
        description,
        image,
        attributes,
      },
      links: {
        image,
      },
      json_uri: asString(row.metadata_uri) ?? asString(content.json_uri) ?? asString(row.uri),
    },
    ownership: {
      owner,
    },
    grouping: collection ? [{ group_key: "collection", group_value: collection }] : [],
    token_info: {
      token_program: asString(row.token_program) ?? asString(row.standard),
    },
    interface: asString(row.interface) ?? asString(row.standard),
  };
}

async function lookupByCollection(mint: string, collectionAddress: string): Promise<Record<string, unknown> | null> {
  const searchParams = new URLSearchParams({
    network: DEFAULT_NETWORK,
    collection_address: collectionAddress,
    size: "50",
  });

  for (let page = 1; page <= MAX_COLLECTION_PAGES; page += 1) {
    searchParams.set("page", String(page));
    const payload = await fetchShyftJson("/sol/v1/collections/get_nfts", searchParams);
    const rows = rowsFromShyftPayload(payload);
    const match = rows.find((row) => asString(row.mint) === mint);
    if (match) return normalizeShyftRecord(match, mint, collectionAddress);
    if (rows.length === 0) break;
    if (rows.length < 50) break;
  }

  return null;
}

async function lookupByOwner(mint: string, ownerAddress: string): Promise<Record<string, unknown> | null> {
  const searchParams = new URLSearchParams({
    network: DEFAULT_NETWORK,
    wallet: ownerAddress,
  });

  const payload = await fetchShyftJson("/sol/v1/wallet/all_tokens", searchParams);
  const rows = uniqueRecords(rowsFromShyftPayload(payload));
  const match = rows.find((row) => asString(row.mint) === mint || asString(row.address) === mint);
  if (!match) return null;
  return normalizeShyftRecord(match, mint, null);
}

export async function fetchShyftAssetByMint(input: { mint: string; owner?: string | null; collection?: string | null }): Promise<ShyftAssetLookupResult> {
  if (!shyftApiKey()) {
    return { provider: "shyft", status: "unavailable", asset: null, owner: null, collection: null, error: "Missing SHYFT_API_KEY", endpoint: null };
  }

  try {
    if (input.collection) {
      const byCollection = await lookupByCollection(input.mint, input.collection);
      if (byCollection) {
        return {
          provider: "shyft",
          status: "ok",
          asset: byCollection,
          owner: asString(asRecord(asRecord(byCollection).ownership).owner),
          collection: input.collection,
          error: null,
          endpoint: "/sol/v1/collections/get_nfts",
        };
      }
    }

    if (input.owner) {
      const byOwner = await lookupByOwner(input.mint, input.owner);
      if (byOwner) {
        return {
          provider: "shyft",
          status: "ok",
          asset: byOwner,
          owner: input.owner,
          collection: asString(asRecord((asRecord(byOwner).grouping as unknown[])[0]).group_value),
          error: null,
          endpoint: "/sol/v1/wallet/all_tokens",
        };
      }
    }

    return {
      provider: "shyft",
      status: "incomplete",
      asset: null,
      owner: input.owner ?? null,
      collection: input.collection ?? null,
      error: "Shyft did not return a matching NFT",
      endpoint: input.collection ? "/sol/v1/collections/get_nfts" : "/sol/v1/wallet/all_tokens",
    };
  } catch (error) {
    return {
      provider: "shyft",
      status: "error",
      asset: null,
      owner: input.owner ?? null,
      collection: input.collection ?? null,
      error: error instanceof Error ? error.message : "Shyft request failed",
      endpoint: input.collection ? "/sol/v1/collections/get_nfts" : "/sol/v1/wallet/all_tokens",
    };
  }
}

export function hasShyftApiKey() {
  return Boolean(shyftApiKey());
}

export function getShyftStatus() {
  return {
    enabled: hasShyftApiKey(),
    apiUrl: shyftBaseUrl(),
  };
}
