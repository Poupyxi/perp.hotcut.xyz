type RuntimeEnv = Record<string, string | undefined>;

type HeliusKey = {
  key: string;
  index: number;
};

type SelectedHeliusKey = HeliusKey & {
  availableCount: number;
};

type HeliusRequestOptions = {
  label: string;
  endpoint: string;
  init: RequestInit;
};

const cooldownUntilByIndex = new Map<number, number>();

let requestCounter = 0;
let nextCursor = 0;

function env(): RuntimeEnv {
  return (globalThis as unknown as { process?: { env?: RuntimeEnv } }).process?.env ?? {};
}

function isEnabled() {
  return env().HELIUS_TEST_ROTATION_ENABLED === "true";
}

function cooldownSeconds() {
  const parsed = Number(env().HELIUS_TEST_KEY_COOLDOWN_SECONDS ?? 30);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

function force429Every() {
  const parsed = Number(env().HELIUS_TEST_FORCE_429_EVERY ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function rawKeys() {
  const keys = (env().HELIUS_API_KEYS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const fallback = env().HELIUS_API_KEY?.trim();
  if (fallback && !keys.includes(fallback)) keys.push(fallback);
  return keys.length ? keys : fallback ? [fallback] : [];
}

function keys(): HeliusKey[] {
  return rawKeys().map((key, position) => ({ key, index: position + 1 }));
}

function now() {
  return Date.now();
}

function isCoolingDown(index: number) {
  const until = cooldownUntilByIndex.get(index) ?? 0;
  if (until <= now()) {
    cooldownUntilByIndex.delete(index);
    return false;
  }
  return true;
}

function availableKeys(excluded = new Set<number>()) {
  return keys().filter((entry) => !excluded.has(entry.index) && !isCoolingDown(entry.index));
}

function selectedKey(excluded = new Set<number>()): SelectedHeliusKey | null {
  const available = availableKeys(excluded);
  if (!available.length) return null;
  const useRotation = isEnabled() && available.length > 1;
  const selected = useRotation ? available[nextCursor % available.length] : available[0];
  nextCursor = useRotation ? (nextCursor + 1) % available.length : 0;
  return { ...selected, availableCount: available.length };
}

function peekKey(excluded = new Set<number>()) {
  return availableKeys(excluded)[0] ?? null;
}

function putKeyInCooldown(index: number) {
  cooldownUntilByIndex.set(index, now() + cooldownSeconds() * 1000);
  console.log(`[HELIUS ROTATION] key #${index} placed in cooldown for ${cooldownSeconds()}s`);
}

function shouldSimulate429() {
  const every = force429Every();
  if (!isEnabled() || every <= 0) return false;
  requestCounter += 1;
  return requestCounter % every === 0;
}

function endpointWithKey(endpoint: string, key: string) {
  const url = new URL(endpoint);
  url.searchParams.set("api-key", key);
  return url.toString();
}

export class HeliusKeysUnavailableError extends Error {
  constructor(message = "All Helius API keys are unavailable") {
    super(message);
    this.name = "HeliusKeysUnavailableError";
  }
}

export function hasHeliusApiKey() {
  return keys().length > 0;
}

export function isHeliusKeysUnavailableError(error: unknown) {
  return error instanceof HeliusKeysUnavailableError;
}

export async function fetchWithHeliusKey(options: HeliusRequestOptions): Promise<Response> {
  const configuredKeys = keys();
  if (!configuredKeys.length) throw new HeliusKeysUnavailableError("Missing HELIUS_API_KEY or HELIUS_API_KEYS");

  const attempted = new Set<number>();
  const maxAttempts = isEnabled() ? configuredKeys.length : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const selected = selectedKey(attempted);
    if (!selected) {
      console.log("[HELIUS ROTATION] available key count=0");
      throw new HeliusKeysUnavailableError();
    }

    attempted.add(selected.index);
    const simulated429 = shouldSimulate429();
    console.log(`[HELIUS ROTATION] ${options.label} selected key #${selected.index}`);
    console.log(`[HELIUS ROTATION] available key count=${selected.availableCount}`);
    console.log(`[HELIUS ROTATION] simulated 429=${simulated429}`);

    if (simulated429) {
      putKeyInCooldown(selected.index);
      const next = peekKey(attempted);
      console.log(`[HELIUS ROTATION] next key selected=${next ? `key #${next.index}` : "none"}`);
      continue;
    }

    const response = await fetch(endpointWithKey(options.endpoint, selected.key), options.init);
    if (response.status !== 429) return response;

    putKeyInCooldown(selected.index);
    const next = peekKey(attempted);
    console.log(`[HELIUS ROTATION] next key selected=${next ? `key #${next.index}` : "none"}`);
  }

  console.log("[HELIUS ROTATION] available key count=0");
  throw new HeliusKeysUnavailableError();
}
