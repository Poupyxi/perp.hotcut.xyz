#!/usr/bin/env node

async function debug() {
  const url = "https://api.collectorcrypt.com/marketplace?categories=Pokemon&marketplaceStatus=Buy+now&marketplaceSource=CC&page=1&step=100";

  console.log("Testing API fetch...");
  console.log("URL:", url);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    console.log("Status:", response.status);

    const data = await response.json() as Record<string, unknown>;
    console.log("Response keys:", Object.keys(data));
    console.log("findTotal:", data.findTotal);

    if (Array.isArray(data.filterNFtCard)) {
      console.log("filterNFtCard length:", data.filterNFtCard.length);

      if (data.filterNFtCard.length > 0) {
        const first = data.filterNFtCard[0] as Record<string, unknown>;
        console.log("First item keys:", Object.keys(first));
        console.log("First item nftAddress:", first.nftAddress);

        const listing = first.listing as Record<string, unknown>;
        console.log("First item listing:", listing ? Object.keys(listing) : "missing");
      }
    } else {
      console.log("filterNFtCard is not an array:", typeof data.filterNFtCard);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : String(error));
  }
}

debug();
