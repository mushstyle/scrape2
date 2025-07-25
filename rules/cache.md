# Cache Rules

## Overview
The scraping engines use an in-memory request cache to avoid redundant downloads of shared resources (CSS, JS, images, fonts, etc.) across multiple pages and sessions.

## How It Works
- **Global Cache**: A single `RequestCache` instance is shared by ALL sessions within an engine run
- **Automatic**: Caching is enabled by default (disable with `--disable-cache`)
- **Transparent**: The cache intercepts network requests automatically via Playwright's route handlers
- **Smart**: Only caches GET requests without auth headers (cookies, authorization)

## Configuration
```bash
# Default settings
--cache-size-mb 250      # Maximum cache size in MB (default: 250)
--cache-ttl-seconds 300  # Time-to-live in seconds (default: 300 = 5 minutes)
--disable-cache          # Disable caching entirely
--no-block-images        # Disable image blocking (images blocked by default)
```

### Image Blocking
The cache now includes integrated image blocking to save bandwidth:
- **Enabled by default**: Images are automatically blocked to reduce bandwidth usage
- **85%+ bandwidth savings**: Typical savings when scraping sites with many images
- **Use `--no-block-images`**: To disable for debugging or when images are needed
- **Tracked in stats**: See `blockedImages` count in cache statistics

## When Caching Helps
- **Item Scraping**: Multiple product pages from the same site share CSS/JS/images
- **Pagination**: Category pages often share the same assets
- **Large Sites**: Sites with many shared resources benefit most

## When NOT to Use Cache
- **Unique Content**: Sites where every page has completely unique resources
- **Dynamic Resources**: Sites that generate unique URLs for the same resources
- **Memory Constraints**: When running with limited memory

## Debugging Cache Performance
After each batch, you'll see cache statistics:
```
[CACHE DEBUG] Batch complete - Hits: 450, Misses: 50, Hit Rate: 90.0%, Size: 45.3MB
```

- **Hit Rate**: Higher is better (80%+ is excellent)
- **Size**: Monitor to ensure it's not exceeding limits
- **Hits vs Misses**: If you see all misses, cache may not be helping

## Implementation Details
- Cache is created once per engine run (not per session)
- All sessions share the same cache instance
- Cache persists across batches within a run
- Cache is cleared when the engine completes

## Common Issues
- **0% Hit Rate**: Usually means resources have unique URLs or cache-busting parameters
- **Memory Growth**: Cache respects size limits and uses LRU eviction
- **Stale Data**: TTL ensures outdated responses are not served