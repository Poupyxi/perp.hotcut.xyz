import { enrichNFTList } from "../src/services/nftListEnrichmentService";

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
