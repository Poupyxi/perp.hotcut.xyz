import { existsSync, readFileSync } from "node:fs";

import { enrichNFTList } from "../src/services/nftListEnrichmentService";

function loadLocalEnvFile() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function argValue(name: string) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function numberArg(name: string) {
  const raw = argValue(name);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanArg(name: string) {
  const raw = argValue(name);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

async function main() {
  loadLocalEnvFile();
  const forceDryRun = process.argv.includes("--dry-run");
  const result = await enrichNFTList({
    mint: argValue("mint"),
    limit: numberArg("limit"),
    dryRun: forceDryRun ? true : booleanArg("dryRun"),
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[NFT LIST ENRICH] Failed");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
