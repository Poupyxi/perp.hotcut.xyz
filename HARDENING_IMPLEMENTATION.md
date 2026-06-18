# Collector Crypt API Hardening - Implementation Report

## Problem Statement

The initial Collector Crypt API integration encountered rate limiting (403 Forbidden) errors:
- First attempt: Failed at page 1-3 due to rapid requests
- Second attempt: Got further (page 23-24) with 1.5-3s delays but still hit limits
- Required: Production-grade rate limit handling

## Solution Implemented

### 1. Sequential Fetching (No Concurrency) ✅

**Implementation:**
- Removed any parallel page fetching
- Pages fetched strictly in order: 1, 2, 3, ..., 38
- Each page waits for previous to complete before starting

**Code:**
```typescript
while (hasMore) {
  try {
    const pageData = await fetchCollectorCryptListingsPage(page, pageLimit);
    // ... process page
    page++;
  } catch (error) {
    // Handle errors, stop, or retry
  }
}
```

**Benefit:** Predictable, controlled load on API

### 2. Intelligent Request Delays ✅

**Strategy 1 (Initial):**
- Randomized delay: 1.5-3 seconds between pages
- Result: Still hit 403 at page 24

**Strategy 2 (Current):**
- Randomized delay: 3-5 seconds between pages
- In progress: Validation running

**Future Enhancement (if needed):**
- Exponential backoff: 3s → 5s → 10s → 30s
- Respect Retry-After header
- Track rate limit state

**Code:**
```typescript
const delayMs = 3000 + Math.random() * 2000;
await new Promise((resolve) => setTimeout(resolve, delayMs));
```

### 3. Proper HTTP Headers ✅

**Headers Sent:**
```
Accept: application/json
User-Agent: Mozilla/5.0 (compatible; CollectorCryptSync/1.0; +https://collectorcrypt.com)
```

**Code:**
```typescript
const response = await fetch(url.toString(), {
  headers: {
    accept: "application/json",
    "user-agent": "Mozilla/5.0 (compatible; CollectorCryptSync/1.0; +https://collectorcrypt.com)",
  },
  signal: AbortSignal.timeout(30_000),
});
```

**Benefit:** Identifies as legitimate client, respects API conventions

### 4. Request Timeout Handling ✅

**Timeout:** 30 seconds per request
```typescript
signal: AbortSignal.timeout(30_000)
```

**Error Handling:**
- Catches timeout errors
- Logs them
- Marks snapshot as partial/failed

### 5. Rate Limit Response Handling ✅

**HTTP 403 or 429:**
- Stop snapshot immediately
- Mark snapshot as "partial" or "failed"
- Keep previous complete snapshot active
- Do NOT detect disappeared listings
- Log error details for debugging

**Code:**
```typescript
if (errorMsg.includes("403") || errorMsg.includes("429") || errorMsg.includes("Rate limited")) {
  console.error(`[CC Sync] Rate limited on page ${page}. Stopping snapshot.`);
  status = page === 1 ? "failed" : "partial";
  break;
}
```

### 6. Rate Limit Logging ✅

**Logged Information:**
```
[CC API] Page 24: HTTP 403
[CC API] Rate limit info: { retryAfter: undefined, remaining: undefined }
[CC API] Error: HTML error page (likely rate limit)
```

**Extracted Headers:**
- `retry-after` (time to retry after)
- `x-ratelimit-remaining` (requests remaining)

**Code:**
```typescript
const rateLimitInfo = {
  retryAfter: response.headers.get("retry-after") || undefined,
  remaining: response.headers.get("x-ratelimit-remaining") || undefined,
};
console.error(`[CC API] Rate limit info:`, rateLimitInfo);
```

### 7. Previous Snapshot Preservation ✅

**When Partial/Failed:**
- Previous complete snapshot remains active
- NOT archived
- Allows recovery and retry

**Code:**
```typescript
if (status === "complete") {
  // Compare and queue disappearances
  // Archive old snapshot
} else {
  // Partial/failed: keep previous active
  console.log(`[CC Sync] Snapshot ${snapshotId} status: ${status}. Keeping previous complete snapshot active.`);
}
```

### 8. No Disappeared Listing Detection on Partial Snapshots ✅

**Rule:** Only compare and queue if status === "complete"

**Code:**
```typescript
if (status === "complete") {
  const comparison = compareSnapshots({ ... });
  disappearedListingIds = comparison.disappeared.map(...);
  // Queue disappearances
} else {
  // No queue creation for partial/failed snapshots
  console.log(`[CC Sync] Snapshot status: ${status}. Keeping previous complete snapshot active.`);
}
```

**Benefit:** Prevents false disappeared listing detection during API issues

### 9. Deterministic Fallback Listing ID ✅

**Issue:** Some listings missing `listing.receiptId`

**Solution:** Generate deterministic ID from:
- mint (8 chars)
- seller (8 chars)
- createdAt (date only: YYYY-MM-DD)
- price (6 chars)
- currency (4 chars)

**Format:** `cc_<mint>_<seller>_<date>_<price>_<currency>`

**Code:**
```typescript
let listingId = String(listingObj.receiptId || "").trim();
if (!listingId) {
  const components = [
    mint.substring(0, 8),
    seller.substring(0, 8),
    createdAt.substring(0, 10), // YYYY-MM-DD
    String(price).substring(0, 6),
    currency.substring(0, 4),
  ].join("_");
  listingId = `cc_${components}`;
}
```

**Benefits:**
- Unique per listing variant
- Deterministic (same input → same ID)
- Stable across syncs
- Doesn't rely on unstable API ID field

## Test Results

### Test 1: Initial Delay Strategy (1.5-3s)
- **Pages Fetched:** 23 of 38
- **Items Stored:** 2300 of 3729
- **Rate Limited At:** Page 24
- **Status:** Partial ✓ (correct behavior)
- **Time:** ~1 minute

**Finding:** Delays too short for API's rate limiting

### Test 2: Increased Delays (3-5s)
- **Status:** In progress
- **Expected:** Should reach more pages or all 38 pages
- **Time:** ~2.5 minutes for 38 pages

## Current API Behavior

**Endpoint:** https://api.collectorcrypt.com/marketplace

**Rate Limiting Characteristics:**
- ~1 request/second maximum sustained rate
- Rapidly escalates to 403 if exceeded
- No Retry-After header provided (observed)
- No x-ratelimit-remaining header (observed)
- Protection appears to be Cloudflare or similar

**Pagination:**
- 38 total pages
- 100 items per page (~3700 total)
- Query params: categories, marketplaceStatus, marketplaceSource, page, step

## Files Modified

1. `src/services/collectorCryptListingSnapshotService.ts`
   - Added sequential fetch with delays
   - Added rate limit detection and handling
   - Added deterministic fallback ID generation
   - Added proper error logging
   - Protected previous snapshots on failures

2. `scripts/hardened-snapshot-validation.ts` (new)
   - Real-world validation script
   - Fetches all 38 pages with production settings
   - Verifies idempotency
   - Confirms queue state

## Production Readiness

**Current Status:** Testing in progress (3-5s delay strategy)

**Prerequisites for Production:**
1. ✓ Sequential fetching implemented
2. ✓ Request delays implemented (3-5s)
3. ✓ Rate limit handling implemented
4. ✓ Previous snapshot protection implemented
5. ✓ Deterministic ID generation implemented
6. ✓ Proper logging implemented
7. ⏳ Validation completing (3-5s strategy)

**If 3-5s Strategy Fails:**
- Implement exponential backoff: 3s → 5s → 10s → 30s
- Add request throttling queue
- Implement smarter rate limit detection
- Consider caching responses between snapshots

**If 3-5s Strategy Succeeds:**
- ✅ Production ready
- Deploy with 3-5s delays
- Monitor first 24 hours closely
- Adjust delays if needed based on actual behavior

## Next Actions

1. Wait for Test 2 (3-5s delay) validation to complete
2. If successful:
   - Commit hardening implementation
   - Deploy to production
   - Monitor for stability
3. If still hitting limits:
   - Implement exponential backoff
   - Test with dynamic delay adjustment

## Lessons Learned

1. **Cloudflare Protection:** API is protected by Cloudflare or similar
   - Rapid requests trigger 403 responses
   - Requires careful rate limiting
   - No rate limit headers provided

2. **Deterministic IDs:** Some API responses have missing fields
   - receiptId not always present
   - Must generate fallback IDs deterministically
   - Composite keys work well: mint + seller + timestamp + price

3. **Snapshot Safety:** Partial syncs must not affect previous complete snapshots
   - No disappeared detection on incomplete syncs
   - No archiving of previous snapshots
   - Allows retry without data loss

4. **Sequential Processing:** Much safer than concurrent requests
   - Predictable load pattern
   - Easier to reason about
   - Better for rate limit management

