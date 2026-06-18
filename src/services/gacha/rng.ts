import { createHash, createHmac, randomBytes } from "node:crypto";
import type { GachaOdds, GachaTier } from "./odds";

export type DrawResult = {
  drawId: string;
  serverSeedHex: string;
  commitHex: string;
  clientNonce: string;
  tier: GachaTier;
  valueSol: number;
  roll: number;
};

export function generateDrawId(): string {
  return randomBytes(16).toString("hex");
}

export function generateServerSeed(): string {
  return randomBytes(32).toString("hex");
}

export function commit(serverSeedHex: string, drawId: string): string {
  return createHash("sha256").update(`${serverSeedHex}:${drawId}`).digest("hex");
}

function deterministicRoll(serverSeedHex: string, drawId: string, clientNonce: string, salt: string): number {
  const hmac = createHmac("sha256", Buffer.from(serverSeedHex, "hex"));
  hmac.update(drawId);
  hmac.update(":");
  hmac.update(clientNonce);
  hmac.update(":");
  hmac.update(salt);
  const digest = hmac.digest();
  const slice = digest.readBigUInt64BE(0);
  // Convert to [0,1) with 53-bit precision.
  const scaled = Number(slice >> 11n) / 2 ** 53;
  return scaled;
}

export function pickTier(odds: GachaOdds, roll: number): GachaTier {
  let cumulative = 0;
  for (const tier of odds.tiers) {
    cumulative += tier.probability;
    if (roll < cumulative) return tier;
  }
  return odds.tiers[odds.tiers.length - 1];
}

export function pickValueInTier(tier: GachaTier, valueRoll: number): number {
  return tier.valueMinSol + (tier.valueMaxSol - tier.valueMinSol) * valueRoll;
}

export function rollDraw(input: {
  odds: GachaOdds;
  drawId: string;
  serverSeedHex: string;
  clientNonce: string;
}): DrawResult {
  const tierRoll = deterministicRoll(input.serverSeedHex, input.drawId, input.clientNonce, "tier");
  const valueRoll = deterministicRoll(input.serverSeedHex, input.drawId, input.clientNonce, "value");
  const tier = pickTier(input.odds, tierRoll);
  const valueSol = pickValueInTier(tier, valueRoll);
  return {
    drawId: input.drawId,
    serverSeedHex: input.serverSeedHex,
    commitHex: commit(input.serverSeedHex, input.drawId),
    clientNonce: input.clientNonce,
    tier,
    valueSol,
    roll: tierRoll,
  };
}

export function verifyDraw(input: {
  serverSeedHex: string;
  drawId: string;
  commitHex: string;
  clientNonce: string;
  odds: GachaOdds;
  expectedTierName: string;
}): boolean {
  if (commit(input.serverSeedHex, input.drawId) !== input.commitHex) return false;
  const tierRoll = deterministicRoll(input.serverSeedHex, input.drawId, input.clientNonce, "tier");
  const tier = pickTier(input.odds, tierRoll);
  return tier.name === input.expectedTierName;
}
