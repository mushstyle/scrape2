# Shared Cache Implementation Plan

## Problem
Currently, each session gets its own isolated RequestCache, meaning:
- No cache sharing between sessions scraping the same domain
- Common resources (CSS, JS, images) are downloaded repeatedly
- Cache dies when sessions are destroyed
- 0% cache hit rate for item scraping

## Solution
Implement domain-based cache sharing where all sessions scraping the same domain share a single RequestCache instance.

## Implementation

### 1. Add Domain Cache Map to Engines
In both `paginate-engine.ts` and `scrape-item-engine.ts`:
```typescript
private domainCaches = new Map<string, RequestCache>();
```

### 2. Create/Get Domain Cache
When creating browsers for sessions, instead of creating cache per session:
```typescript
// Get or create cache for this domain
const domain = /* extract domain from session/target */;
let domainCache = this.domainCaches.get(domain);
if (!domainCache && cacheOptions) {
  domainCache = new RequestCache({
    maxSizeBytes: cacheOptions.cacheSizeMB * 1024 * 1024,
    ttlSeconds: cacheOptions.cacheTTLSeconds
  });
  this.domainCaches.set(domain, domainCache);
}

// Assign same cache to all sessions for this domain
sessionData.cache = domainCache;
```

### 3. Clean Up Domain Caches
In cleanup methods, clear the domainCaches map:
```typescript
this.domainCaches.clear();
```

## Benefits
- Sessions scraping cos.com share all cached resources
- Cache persists across batches within an engine run
- Massive reduction in redundant downloads
- Simple implementation with minimal changes

## Testing
1. Run item scraper on cos.com with multiple sessions
2. Should see cache hits increasing after first few items
3. Verify shared resources (CSS, JS) are only downloaded once per domain

## Documentation
Create `/rules/cache.md` to document proper cache usage:
- When to use caching (item scraping, paginate with shared resources)
- How the domain-based cache sharing works
- Cache configuration options (size, TTL)
- Best practices for cache-friendly scraping
- Debugging cache performance (hit rates, size)
- When NOT to use caching (sites with unique resources per page)