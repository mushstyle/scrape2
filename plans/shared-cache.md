# Shared Cache Implementation Plan

## Problem
Currently, each session gets its own isolated RequestCache, meaning:
- No cache sharing between sessions scraping the same domain
- Common resources (CSS, JS, images) are downloaded repeatedly
- Cache dies when sessions are destroyed
- 0% cache hit rate for item scraping

## Solution
Implement a single global cache shared by all sessions in an engine run.

## Implementation

### 1. Add Global Cache to Engines
In both `paginate-engine.ts` and `scrape-item-engine.ts`:
```typescript
private globalCache: RequestCache | null = null;
```

### 2. Create Global Cache Once
At the start of the run, create a single cache instance:
```typescript
// Create global cache once if caching enabled
if (cacheOptions && !this.globalCache) {
  this.globalCache = new RequestCache({
    maxSizeBytes: cacheOptions.cacheSizeMB * 1024 * 1024,
    ttlSeconds: cacheOptions.cacheTTLSeconds
  });
}

// Assign same cache to all sessions
sessionData.cache = this.globalCache;
```

### 3. Clean Up Global Cache
In cleanup methods:
```typescript
this.globalCache = null;
```

## Benefits
- All sessions share cached resources regardless of domain
- Cache persists across batches within an engine run
- Massive reduction in redundant downloads
- Simpler implementation - just one cache to manage
- Single memory limit prevents explosion

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