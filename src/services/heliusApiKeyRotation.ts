// Helius API key rotation with:
//   - round-robin across multiple keys (always on when count >= 2)
//   - 429 detected as short cooldown ("throttled")
//   - 401/403 detected as long cooldown ("cancelled / quota exhausted")
//   - per-key call + error + lamport-credit counters
//   - jittered User-Agent rotation to reduce fingerprinting / cancels
//   - inspectable state via getHeliusKeyStats()
//
// Configuration (env):
//   HELIUS_API_KEYS               comma-separated list of keys (preferred)
//   HELIUS_API_KEY                single fallback key (used if HELIUS_API_KEYS empty)
//   HELIUS_KEY_COOLDOWN_SECONDS   short cooldown after 429 (default 30)
//   HELIUS_KEY_CANCEL_COOLDOWN_SECONDS  long cooldown after 401/403 (default 1800 = 30 min)
//   HELIUS_REQUEST_JITTER_MS      max jitter per request, ms (default 0 = disabled)
//   HELIUS_ROTATION_ENABLED       force rotation on/off (default: auto = on if >=2 keys)
//   HELIUS_TEST_FORCE_429_EVERY   debug: artificially trigger 429 every N calls (default 0)
//
// Backwards-compat: HELIUS_TEST_ROTATION_ENABLED still respected, but no longer
// required — rotation engages automatically when 2+ keys are configured.

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

type KeyStats = {
  index: number;
  keyPrefix: string;
  calls: number;
  errors429: number;
  errors4xxAuth: number;
  errorsOther: number;
  lastCallAt: string | null;
  lastErrorAt: string | null;
  cooldownUntil: string | null;
  cooldownReason: "throttled" | "cancelled" | null;
};

const cooldownUntilByIndex = new Map<number, { until: number; reason: "throttled" | "cancelled" }>();
const stats = new Map<number, KeyStats>();

let requestCounter = 0;
let nextCursor = 0;

const USER_AGENTS = [
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
];

function env(): RuntimeEnv {
  return (globalThis as unknown as { process?: { env?: RuntimeEnv } }).process?.env ?? {};
}

function rotationEnabled(): boolean {
  const explicit = env().HELIUS_ROTATION_ENABLED?.toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  // legacy flag
  if (env().HELIUS_TEST_ROTATION_ENABLED === "true") return true;
  return keys().length >= 2;
}

function cooldownSeconds(): number {
  const parsed = Number(env().HELIUS_KEY_COOLDOWN_SECONDS ?? env().HELIUS_TEST_KEY_COOLDOWN_SECONDS ?? 30);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

function cancelCooldownSeconds(): number {
  const parsed = Number(env().HELIUS_KEY_CANCEL_COOLDOWN_SECONDS ?? 1800);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1800;
}

function jitterMs(): number {
  const parsed = Number(env().HELIUS_REQUEST_JITTER_MS ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function force429Every(): number {
  const parsed = Number(env().HELIUS_TEST_FORCE_429_EVERY ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function rawKeys(): string[] {
  const keys = (env().HELIUS_API_KEYS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const fallback = env().HELIUS_API_KEY?.trim();
  if (fallback && !keys.includes(fallback)) keys.push(fallback);
  return keys;
}

function keys(): HeliusKey[] {
  return rawKeys().map((key, position) => ({ key, index: position + 1 }));
}

function now(): number {
  return Date.now();
}

function statFor(index: number, key: string): KeyStats {
  let s = stats.get(index);
  if (!s) {
    s = {
      index,
      keyPrefix: key.slice(0, 8),
      calls: 0,
      errors429: 0,
      errors4xxAuth: 0,
      errorsOther: 0,
      lastCallAt: null,
      lastErrorAt: null,
      cooldownUntil: null,
      cooldownReason: null,
    };
    stats.set(index, s);
  }
  return s;
}

function isCoolingDown(index: number): boolean {
  const entry = cooldownUntilByIndex.get(index);
  if (!entry) return false;
  if (entry.until <= now()) {
    cooldownUntilByIndex.delete(index);
    const s = stats.get(index);
    if (s) {
      s.cooldownUntil = null;
      s.cooldownReason = null;
    }
    return false;
  }
  return true;
}

function availableKeys(excluded = new Set<number>()): HeliusKey[] {
  return keys().filter((entry) => !excluded.has(entry.index) && !isCoolingDown(entry.index));
}

function selectedKey(excluded = new Set<number>()): SelectedHeliusKey | null {
  const available = availableKeys(excluded);
  if (!available.length) return null;
  const useRotation = rotationEnabled() && available.length > 1;
  const selected = useRotation ? available[nextCursor % available.length] : available[0];
  nextCursor = useRotation ? (nextCursor + 1) % available.length : 0;
  return { ...selected, availableCount: available.length };
}

function peekKey(excluded = new Set<number>()): HeliusKey | null {
  return availableKeys(excluded)[0] ?? null;
}

function putKeyInCooldown(index: number, key: string, reason: "throttled" | "cancelled"): void {
  const seconds = reason === "cancelled" ? cancelCooldownSeconds() : cooldownSeconds();
  const until = now() + seconds * 1000;
  cooldownUntilByIndex.set(index, { until, reason });
  const s = statFor(index, key);
  s.cooldownUntil = new Date(until).toISOString();
  s.cooldownReason = reason;
  console.warn(
    `[HELIUS ROTATION] key #${index} (${key.slice(0, 8)}...) → ${reason} cooldown ${seconds}s`,
  );
}

function shouldSimulate429(): boolean {
  const every = force429Every();
  if (every <= 0) return false;
  requestCounter += 1;
  return requestCounter % every === 0;
}

function endpointWithKey(endpoint: string, key: string): string {
  const url = new URL(endpoint);
  url.searchParams.set("api-key", key);
  return url.toString();
}

function pickUserAgent(index: number): string {
  return USER_AGENTS[(index - 1) % USER_AGENTS.length];
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(): Promise<void> {
  const max = jitterMs();
  if (max <= 0) return Promise.resolve();
  return sleep(Math.floor(Math.random() * max));
}

function decorateInit(init: RequestInit, index: number): RequestInit {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("user-agent")) headers.set("user-agent", pickUserAgent(index));
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (!headers.has("accept-language")) headers.set("accept-language", index % 2 === 0 ? "en-US,en;q=0.9" : "en-GB,en;q=0.8");
  return { ...init, headers };
}

export class HeliusKeysUnavailableError extends Error {
  constructor(message = "All Helius API keys are unavailable") {
    super(message);
    this.name = "HeliusKeysUnavailableError";
  }
}

export function hasHeliusApiKey(): boolean {
  return keys().length > 0;
}

export function isHeliusKeysUnavailableError(error: unknown): boolean {
  return error instanceof HeliusKeysUnavailableError;
}

export function getHeliusKeyStats() {
  const all = keys().map((k) => statFor(k.index, k.key));
  return {
    rotationEnabled: rotationEnabled(),
    keyCount: keys().length,
    cooldownSeconds: cooldownSeconds(),
    cancelCooldownSeconds: cancelCooldownSeconds(),
    jitterMs: jitterMs(),
    keys: all,
  };
}

export async function fetchWithHeliusKey(options: HeliusRequestOptions): Promise<Response> {
  const configuredKeys = keys();
  if (!configuredKeys.length) throw new HeliusKeysUnavailableError("Missing HELIUS_API_KEY or HELIUS_API_KEYS");

  const attempted = new Set<number>();
  const maxAttempts = rotationEnabled() ? configuredKeys.length : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const selected = selectedKey(attempted);
    if (!selected) {
      console.warn("[HELIUS ROTATION] No available keys (all in cooldown)");
      throw new HeliusKeysUnavailableError();
    }
    attempted.add(selected.index);

    await jitter();

    const stat = statFor(selected.index, selected.key);
    stat.calls += 1;
    stat.lastCallAt = new Date().toISOString();

    if (shouldSimulate429()) {
      stat.errors429 += 1;
      stat.lastErrorAt = stat.lastCallAt;
      putKeyInCooldown(selected.index, selected.key, "throttled");
      continue;
    }

    const decoratedInit = decorateInit(options.init, selected.index);
    let response: Response;
    try {
      response = await fetch(endpointWithKey(options.endpoint, selected.key), decoratedInit);
    } catch (err) {
      stat.errorsOther += 1;
      stat.lastErrorAt = new Date().toISOString();
      console.warn(`[HELIUS ROTATION] key #${selected.index} network error: ${err instanceof Error ? err.message : err}`);
      putKeyInCooldown(selected.index, selected.key, "throttled");
      continue;
    }

    if (response.status === 429) {
      stat.errors429 += 1;
      stat.lastErrorAt = new Date().toISOString();
      putKeyInCooldown(selected.index, selected.key, "throttled");
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      stat.errors4xxAuth += 1;
      stat.lastErrorAt = new Date().toISOString();
      putKeyInCooldown(selected.index, selected.key, "cancelled");
      // We do NOT retry on the same call beyond marking the key — next attempt picks another key.
      continue;
    }

    if (!response.ok && response.status >= 500) {
      stat.errorsOther += 1;
      stat.lastErrorAt = new Date().toISOString();
      // Don't cooldown for server errors — but try next key for resilience.
      const next = peekKey(attempted);
      if (next) continue;
    }

    return response;
  }

  console.warn("[HELIUS ROTATION] exhausted all keys");
  throw new HeliusKeysUnavailableError();
}
