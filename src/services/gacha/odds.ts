import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type GachaTier = {
  name: string;
  valueMinSol: number;
  valueMaxSol: number;
  probability: number;
};

export type GachaOdds = {
  packPriceSol: number;
  refundRate: number;
  decisionWindowSeconds: number;
  fallbackOnAcceptFail: "refund" | "redraw" | "equivalent";
  tiers: GachaTier[];
};

const PROBABILITY_TOLERANCE = 1e-6;

function configPath() {
  const override = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.GACHA_ODDS_PATH;
  return resolve(process.cwd(), override || "config/gacha-odds.json");
}

function validate(raw: unknown): GachaOdds {
  if (!raw || typeof raw !== "object") throw new Error("gacha-odds.json must be a JSON object");
  const obj = raw as Record<string, unknown>;

  const packPriceSol = Number(obj.packPriceSol);
  const refundRate = Number(obj.refundRate);
  const decisionWindowSeconds = Number(obj.decisionWindowSeconds);
  const fallback = String(obj.fallbackOnAcceptFail ?? "refund");

  if (!Number.isFinite(packPriceSol) || packPriceSol <= 0) throw new Error("packPriceSol must be > 0");
  if (!Number.isFinite(refundRate) || refundRate <= 0 || refundRate > 1) throw new Error("refundRate must be in (0,1]");
  if (!Number.isFinite(decisionWindowSeconds) || decisionWindowSeconds < 5 || decisionWindowSeconds > 600) {
    throw new Error("decisionWindowSeconds must be in [5,600]");
  }
  if (!["refund", "redraw", "equivalent"].includes(fallback)) {
    throw new Error('fallbackOnAcceptFail must be "refund" | "redraw" | "equivalent"');
  }

  if (!Array.isArray(obj.tiers) || obj.tiers.length === 0) throw new Error("tiers must be a non-empty array");

  const tiers: GachaTier[] = obj.tiers.map((entry, idx) => {
    if (!entry || typeof entry !== "object") throw new Error(`tier[${idx}] must be an object`);
    const t = entry as Record<string, unknown>;
    const name = String(t.name ?? "").trim();
    const valueMinSol = Number(t.valueMinSol);
    const valueMaxSol = Number(t.valueMaxSol);
    const probability = Number(t.probability);
    if (!name) throw new Error(`tier[${idx}].name is required`);
    if (!Number.isFinite(valueMinSol) || valueMinSol < 0) throw new Error(`tier[${idx}].valueMinSol invalid`);
    if (!Number.isFinite(valueMaxSol) || valueMaxSol < valueMinSol) {
      throw new Error(`tier[${idx}].valueMaxSol must be >= valueMinSol`);
    }
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error(`tier[${idx}].probability must be in [0,1]`);
    }
    return { name, valueMinSol, valueMaxSol, probability };
  });

  const sum = tiers.reduce((acc, t) => acc + t.probability, 0);
  if (Math.abs(sum - 1) > PROBABILITY_TOLERANCE) {
    throw new Error(`tier probabilities must sum to 1, got ${sum.toFixed(6)}`);
  }

  return {
    packPriceSol,
    refundRate,
    decisionWindowSeconds,
    fallbackOnAcceptFail: fallback as GachaOdds["fallbackOnAcceptFail"],
    tiers,
  };
}

let cached: { mtimeMs: number; value: GachaOdds } | null = null;

export function loadGachaOdds(): GachaOdds {
  const path = configPath();
  const stat = statSync(path);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const value = validate(raw);
  cached = { mtimeMs: stat.mtimeMs, value };
  return value;
}

export function expectedValueSol(odds: GachaOdds): number {
  return odds.tiers.reduce((acc, t) => acc + t.probability * ((t.valueMinSol + t.valueMaxSol) / 2), 0);
}

export function houseEdge(odds: GachaOdds): number {
  return 1 - expectedValueSol(odds) / odds.packPriceSol;
}
