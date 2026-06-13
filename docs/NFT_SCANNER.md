# NFT Scanner

The NFT scanner keeps the NFT List enriched with market state without turning listings into verified sales.

## Safety Defaults

`NFT_SCANNER_DRY_RUN` defaults to `true`.

When dry-run is enabled, scanner commands fetch provider data and print what would be inserted or updated. They do not write to SQLite and do not write report files.

Writes are allowed only when:

```bash
NFT_SCANNER_DRY_RUN=false
```

## Data Flow

NFT List is the source of truth for tracked NFT mints.

The recurring flow is:

```text
NFT List
-> market state scanner
-> listing detection
-> sale detection
-> verified sales update
-> market price update
-> NFT List refresh
```

`nft_assets` stores the current NFT state.

`rwa_nft_events` stores historical market events. Verified Sales reads confirmed `SALE` events from this table.

`nft_listing_states` stores active listing snapshots by provider, mint, and listing id.

## Price Rules

Listings are not sales.

`latestMarketPrice` uses this priority:

1. Latest verified sale price
2. Latest confirmed purchase price
3. Active listing price as secondary context
4. `null` when unavailable

The future perp/index engine must use verified executed sales only. Listing prices must not be used as the primary index source.

## Manual Commands

Provider status:

```bash
npm run providers:status
```

Discover new mints from allowlisted collections:

```bash
npm run discover:new-mints
```

Scan market state for NFTs already in NFT List:

```bash
npm run scan:nft-market-states
```

Run discovery first, then market-state scan:

```bash
npm run refresh:nft-data
```

To write data intentionally:

```bash
NFT_SCANNER_DRY_RUN=false npm run discover:new-mints
NFT_SCANNER_DRY_RUN=false npm run scan:nft-market-states
```

## Runtime Configuration

```bash
ENABLE_NFT_SCANNER=true
NFT_SCANNER_DRY_RUN=true
NFT_SCANNER_BATCH_SIZE=25
NFT_SCANNER_INTERVAL_SECONDS=600
NFT_SCANNER_MAX_RETRIES=3

ENABLE_NEW_MINT_DISCOVERY=true
NEW_MINT_DISCOVERY_INTERVAL_SECONDS=1800
NEW_MINT_DISCOVERY_LIMIT_PER_COLLECTION=500

TRACKED_COLLECTIONS=pokemon-cards,one-piece-cards,nba-cards,nfl-cards,nhl-cards
MAGIC_EDEN_COLLECTION_SYMBOLS=
TENSOR_COLLECTION_SLUGS=
PHYGITALS_COLLECTION_IDS=
COLLECTOR_CRYPT_COLLECTION_IDS=
BEEZIE_COLLECTION_IDS=
```

Provider credentials and endpoints are read from environment variables. Secrets must not be hardcoded.

## API Endpoints

Protected endpoints require `REFRESH_SECRET` via `x-refresh-secret` or `Authorization: Bearer <secret>`.

```text
POST /api/scan/nft-market-states
POST /api/discover/new-mints
POST /api/refresh/nft-data
GET  /api/providers/status
GET  /api/nfts
GET  /api/nfts/:assetMint/market-state
GET  /api/verified-sales
GET  /api/verified-sales/latest
```

## Cron Later

Do not configure cron automatically from the app.

When ready, run a server cron outside the application, for example:

```bash
cd /opt/apps/perp-rwa
NFT_SCANNER_DRY_RUN=false npm run refresh:nft-data
```

Keep intervals conservative. The current intended cadence is roughly 10 minutes for market-state refresh and 30 minutes for new mint discovery.
