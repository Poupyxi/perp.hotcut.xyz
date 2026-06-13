import { discoverNewMintsFromTrackedCollections } from "../src/services/nftMintDiscoveryService";
import { scanAllNFTMarketStates } from "../src/services/nftMarketStateScannerService";

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
  const dryRun = booleanArg("dryRun");
  const discovery = await discoverNewMintsFromTrackedCollections({
    collection: argValue("collection"),
    limitPerCollection: numberArg("limitPerCollection") ?? numberArg("discoveryLimit"),
    dryRun,
  });
  const scan = await scanAllNFTMarketStates({
    mint: argValue("mint"),
    limit: numberArg("limit"),
    all: booleanArg("all") ?? false,
    dryRun,
  });

  console.log(JSON.stringify({ discovery, scan }, null, 2));
  if (discovery.errors.length || scan.errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[NFT REFRESH] NFT data refresh failed");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
