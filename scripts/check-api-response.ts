#!/usr/bin/env node

async function check() {
  const baseUrl = "https://api.collectorcrypt.com";
  const endpoint = "/marketplace";

  const url = new URL(endpoint, baseUrl);
  url.searchParams.set("categories", "Pokemon");
  url.searchParams.set("marketplaceStatus", "Buy now");
  url.searchParams.set("marketplaceSource", "CC");
  url.searchParams.set("page", "1");
  url.searchParams.set("step", "100");

  console.log("URL:", url.toString());
  console.log("\nFetching...\n");

  try {
    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(30_000),
    });

    console.log("Status:", response.status);
    console.log("Content-Type:", response.headers.get("content-type"));

    const text = await response.text();
    console.log("First 500 chars:");
    console.log(text.substring(0, 500));

    if (text.includes("<!DOCTYPE")) {
      console.log("\n⚠️  API returned HTML (possibly error page or rate limit)");
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : String(error));
  }
}

check();
