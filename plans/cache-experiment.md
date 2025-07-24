# Cache Experiment Plan

## Overview
Create a SIMPLE cache testing script that bypasses the database entirely and loops through TEST_URLS exactly once, measuring cache performance.

## CRITICAL REQUIREMENTS
1. **NO DATABASE WRITES** - This script must NOT write to any database
2. **NO MARKING ITEMS AS DONE** - We don't need any item tracking
3. **SINGLE PASS ONLY** - Loop through URLs exactly once and stop
4. **BYPASS THE ENGINE** - Create a direct scraping loop, don't use ScrapeItemEngine

## Implementation Details

### File Location
`examples/cache-experiment.ts`

### Architecture
- Create browsers/sessions directly using drivers
- Loop through TEST_URLS exactly once
- Measure cache stats manually
- NO SiteManager database operations
- NO item tracking or status updates

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

1. **Direct Browser/Session Creation**
   - Create a single browser session using providers/drivers directly
   - Configure cache settings if enabled
   - NO database interactions

2. **Simple URL Loop**
   ```typescript
   for (const url of TEST_URLS) {
     // Scrape URL directly
     // Collect cache stats
     // NO database updates
   }
   ```

3. **Cache Tracking**
   - Track cache hits/misses manually
   - Calculate bandwidth saved
   - Measure response times

4. **Cost Calculation**
   ```typescript
   const COST_PER_GB = 0.20; // Browserbase pricing
   // Simple calculation based on actual downloads
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

1. **Direct Scraping Approach**
   - NO ScrapeItemEngine usage
   - NO database operations
   - Create browser/session directly
   - Loop through URLs exactly once

2. **Simple Cache Measurement**
   - Count requests that hit cache vs miss
   - Estimate bandwidth based on page sizes
   - Calculate cost savings

3. **Clean Exit**
   - Process all URLs once
   - Display results
   - Exit cleanly

4. **Package.json Script**
   ```json
   "example:cache-experiment": "tsx examples/cache-experiment.ts"
   ```

## Success Criteria

1. **NO INFINITE LOOPS** - Processes each URL exactly once
2. **NO DATABASE WRITES** - Zero database interactions
3. Shows cache effectiveness clearly
4. Exits cleanly after one pass
5. Simple, direct implementation

## Testing

1. Verify it processes 10 URLs and stops
2. Confirm NO database writes occur
3. Check cache stats are measured
4. Ensure clean exit