import { getProviderStatusReport, runProviderSalesIngestion } from "./ingest";
import { getMarketActivityProviderStatusReport } from "../../services/nftMarketActivityConnectors";
import type { ProviderId } from "./types";

const PROVIDERS = new Set<ProviderId>(["magic-eden", "tensor", "phygitals", "collector-crypt"]);

function providerArg(args: string[]): ProviderId | undefined {
  const index = args.indexOf("--provider");
  if (index === -1) return undefined;
  const value = args[index + 1] as ProviderId | undefined;
  if (!value || !PROVIDERS.has(value)) throw new Error(`Unknown provider: ${value ?? "missing"}`);
  return value;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "ingest") {
    const result = await runProviderSalesIngestion({ provider: providerArg(args) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "status") {
    console.log(JSON.stringify({
      ...(await getProviderStatusReport()),
      ...getMarketActivityProviderStatusReport(),
    }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command ?? "missing"}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
