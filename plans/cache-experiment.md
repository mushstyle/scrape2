# Cache Experiment Plan

## Overview
Create an example script to measure caching effectiveness and cost savings by scraping a fixed set of URLs with and without caching enabled.

## Requirements
1. Use 10 hardcoded URLs (provided by user)
2. **DO NOT modify the scrape engine** - use it as-is via its public interface
3. Script command: `npm run example:cache-experiment`

## Implementation Details

### File Location
`examples/cache-experiment.ts`

### Architecture
- Use existing `ScrapeItemEngine` without modifications
- Create `SiteManager` and `SessionManager` instances
- Call engine's `scrapeItems()` method with appropriate options

### Test URLs

The following 10 cos.com URLs will be used for the experiment:

```typescript
const TEST_URLS = [
  'https://www.cos.com/en-us/men/menswear/shirts/casualshirts/product/relaxed-twill-shirt-navy-1245704006',
  'https://www.cos.com/en-us/men/menswear/shirts/shortsleevedshirts/product/cotton-seersucker-resort-shirt-navy-1281649001',
  'https://www.cos.com/en-us/men/menswear/shirts/shortsleevedshirts/product/relaxed-short-sleeved-resort-shirt-blue-graphic-1282012002',
  'https://www.cos.com/en-us/men/menswear/shirts/shortsleevedshirts/product/camp-collar-linen-shirt-cobalt-1298721002',
  'https://www.cos.com/en-us/men/menswear/shirts/shortsleevedshirts/product/camp-collar-linen-shirt-white-blue-striped-1298721001',
  'https://www.cos.com/en-us/men/menswear/shirts/shortsleevedshirts/product/relaxed-flap-pocket-utility-shirt-apricot-1230855004',
  'https://www.cos.com/en-us/men/menswear/poloshirts/product/interlock-cotton-polo-shirt-white-1281644001',
  'https://www.cos.com/en-us/men/menswear/knitwear/knitted-polo-shirts/product/open-knit-boucl-polo-shirt-mole-mlange-1281652001',
  'https://www.cos.com/en-us/men/menswear/tshirts/slim-fit/product/slim-knitted-silk-t-shirt-grey-beige-1241762007',
  'https://www.cos.com/en-us/men/menswear/knitwear/cardigans/product/knit-panelled-cardigan-navy-1292174001'
];
```

### Core Functionality

1. **Setup Phase**
   - Use the hardcoded TEST_URLS array above
   - Create required managers (SiteManager, SessionManager)
   - Instantiate ScrapeItemEngine

2. **Execution Phases**
   - **Phase 1: With Cache** (default behavior)
     - Run with cache enabled
     - Capture cache statistics from result
     - Record MB downloaded and MB saved
   
   - **Phase 2: Without Cache** (when --no-cache flag is used)
     - Run with `disableCache: true` option
     - Record total MB downloaded
     - Calculate what would have been cached

3. **Metrics Collection**
   - MB downloaded from network
   - MB served from cache (bandwidth saved)
   - Cache hit rate percentage
   - Cost calculations based on bandwidth usage

4. **Cost Calculation**
   ```typescript
   const COST_PER_GB = 0.20; // Browserbase pricing
   const mbDownloaded = result.cacheStats.bytesDownloaded / (1024 * 1024);
   const mbSaved = result.cacheStats.bytesSaved / (1024 * 1024);
   const costWithoutCache = ((mbDownloaded + mbSaved) / 1024) * COST_PER_GB;
   const actualCost = (mbDownloaded / 1024) * COST_PER_GB;
   ```

### CLI Options
- `--no-cache`: Run without caching to show full bandwidth cost
- `--cache-size-mb <MB>`: Override default cache size (250MB)
- `--cache-ttl <seconds>`: Override default TTL (300s)
- `--local`: Use local browser instead of Browserbase

### Commands
```bash
# Run with caching (default)
npm run example:cache-experiment

# Run without caching
npm run example:cache-experiment -- --no-cache

# Run with custom cache settings
npm run example:cache-experiment -- --cache-size-mb 500 --cache-ttl 600

# Run with local browser
npm run example:cache-experiment -- --local
```

### Output Format
```
=== Cache Experiment Results ===

Configuration:
- URLs tested: 10
- Cache enabled: Yes
- Cache size: 250 MB
- Cache TTL: 300 seconds

Results:
- Items successfully scraped: 10/10
- Network downloaded: 45.2 MB
- Served from cache: 120.8 MB
- Total bandwidth needed: 166.0 MB
- Bandwidth saved: 72.8%
- Cache hit rate: 78.5%

Cost Analysis:
- Cost without cache: $0.033
- Actual cost with cache: $0.009
- Savings: $0.024 (72.8%)

Cache Performance:
- Cache hits: 157
- Cache misses: 43
- Total requests: 200
```

### Implementation Notes

1. **No Engine Modifications**
   - Use ScrapeItemEngine exactly as provided
   - Pass options through the public `scrapeItems()` method
   - Rely on built-in cache statistics in the result

2. **URL Handling**
   - Use the hardcoded TEST_URLS array defined above
   - All URLs are from cos.com for consistency
   - Convert URLs to the format expected by the engine

3. **Error Handling**
   - Handle cases where some items fail to scrape
   - Report partial results if not all items succeed
   - Log detailed errors for debugging

4. **Package.json Script**
   ```json
   "example:cache-experiment": "tsx examples/cache-experiment.ts"
   ```

## Success Criteria

1. Script runs without modifying any engine code
2. Accurately measures bandwidth usage with and without cache
3. Provides clear cost comparison showing savings
4. Outputs easy-to-understand metrics
5. Handles errors gracefully

## Testing

1. Run with default settings and verify output
2. Run with `--no-cache` and confirm no caching occurs
3. Verify cost calculations are accurate
4. Test with local browser option
5. Ensure script handles failed scrapes gracefully