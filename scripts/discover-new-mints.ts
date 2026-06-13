import { discoverNewMintsFromTrackedCollections } from "../src/services/nftMintDiscoveryService";

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
  const result = await discoverNewMintsFromTrackedCollections({
    collection: argValue("collection"),
    limitPerCollection: numberArg("limitPerCollection") ?? numberArg("limit"),
    dryRun: booleanArg("dryRun"),
    storeRaw: booleanArg("storeRaw") ?? false,
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[NFT DISCOVERY] New mint discovery failed");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
