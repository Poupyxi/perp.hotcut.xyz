import { updateNFTMarketStates } from "../src/services/nftMarketStateService";

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

async function main() {
  const mint = argValue("mint");
  const limit = numberArg("limit");
  console.log("[RWA MARKET] Starting NFT market-state refresh");

  const result = await updateNFTMarketStates({ mint, limit });

  console.log("[RWA MARKET] NFT market-state refresh completed");
  console.log(JSON.stringify(result, null, 2));

  if (result.errors.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[RWA MARKET] NFT market-state refresh failed");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
