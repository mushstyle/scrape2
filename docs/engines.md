# Engines

Engines are the top-level orchestrators in our architecture. They coordinate complex workflows using services and core logic.

## Overview

Engines follow these principles:
- **Stateless**: Engines don't maintain state between calls
- **Orchestration only**: They coordinate but don't implement business logic
- **Service composition**: They use services (SiteManager, SessionManager) to perform work
- **Error resilience**: They handle errors gracefully and report detailed results

## PaginateEngine

Orchestrates pagination across multiple sites using the double-pass matcher pattern.

### Usage

```typescript
const engine = new PaginateEngine(siteManager, sessionManager);
const result = await engine.paginate({
  sites: ['site1.com', 'site2.com'],
  instanceLimit: 10,
  maxPages: 5,
  disableCache: false
});
```

### Options

- `sites`: Array of site domains to paginate (optional - defaults to all sites with start pages)
- `instanceLimit`: Maximum concurrent browser sessions (default: 10)
- `maxPages`: Maximum pages to paginate per start page (default: 5)
- `disableCache`: Disable request caching (default: false - caching enabled)
- `cacheSizeMB`: Cache size in MB (default: 100)
- `cacheTTLSeconds`: Cache TTL in seconds (default: 300)
- `noSave`: Skip saving URLs to database (default: false)
- `localHeadless`: Use local browser in headless mode
- `localHeaded`: Use local browser in headed (visible) mode
- `sessionTimeout`: Session timeout in seconds (Browserbase only)
- `maxRetries`: Maximum retries for network errors (default: 2)

### How it Works

1. **Site Collection**: Collects start pages from specified sites (or all sites)
2. **Session Matching**: Uses double-pass matcher to efficiently assign URLs to sessions
   - First pass: Try to match URLs to existing sessions
   - Terminate unused sessions
   - Create only the sessions needed for unmatched URLs
   - Second pass: Match all URLs to all sessions
3. **Pagination**: Each site is paginated independently with:
   - URL deduplication using Set
   - Page-by-page collection up to maxPages
   - Network error retry logic
4. **State Tracking**: Uses SiteManager's partial run system to track progress
5. **Result Aggregation**: Returns comprehensive results including cache statistics

### Result Structure

```typescript
interface PaginateResult {
  success: boolean;              // Overall success status
  sitesProcessed: number;        // Number of sites processed
  totalUrls: number;            // Total URLs collected
  urlsBySite: Map<string, string[]>; // URLs grouped by site
  errors: Map<string, string>;   // Errors by site/URL
  duration: number;             // Total duration in ms
  cacheStats?: {                // Cache statistics (if caching enabled)
    hits: number;
    misses: number;
    hitRate: number;          // Percentage
    totalSizeMB: number;
  };
}
```

## ScrapeItemEngine

Orchestrates scraping of individual items using the double-pass matcher pattern.

### Usage

```typescript
const engine = new ScrapeItemEngine(siteManager, sessionManager);
const result = await engine.scrapeItems({
  sites: ['site1.com', 'site2.com'],
  instanceLimit: 10,
  itemLimit: 100,
  noSave: false
});
```

### Options

- `sites`: Array of site domains to scrape (optional - defaults to all sites with pending items)
- `instanceLimit`: Maximum concurrent browser sessions (default: 10)
- `itemLimit`: Maximum items to scrape per site (default: 100)
- `disableCache`: Disable request caching (default: false - caching enabled)
- `cacheSizeMB`: Cache size in MB (default: 100)
- `cacheTTLSeconds`: Cache TTL in seconds (default: 300)
- `noSave`: Skip saving items to ETL (default: false)
- `localHeadless`: Use local browser in headless mode
- `localHeaded`: Use local browser in headed (visible) mode
- `sessionTimeout`: Session timeout in seconds (Browserbase only)
- `maxRetries`: Maximum retries for network errors (default: 2)

### How it Works

1. **Item Collection**: Gets pending items from active scrape runs
   - Queries sites with active runs (pending or processing status)
   - Limits items per site based on itemLimit
2. **Session Matching**: Uses same double-pass matcher pattern as PaginateEngine
3. **Item Scraping**: For each item URL:
   - Navigate to the page
   - Call site-specific scraper's `scrapeItem()` method
   - Retry navigation errors up to maxRetries times
4. **Status Updates**: Updates scrape run item status:
   - `done: true` - Successfully scraped
   - `failed: true` - Network error after retries
   - `invalid: true` - Other errors (no retry)
5. **ETL Integration**: Saves scraped items to ETL API (unless noSave is true)

### Result Structure

```typescript
interface ScrapeItemResult {
  success: boolean;              // Overall success status
  itemsScraped: number;         // Total items successfully scraped
  itemsBySite: Map<string, Item[]>; // Items grouped by site
  errors: Map<string, string>;   // Errors by URL
  duration: number;             // Total duration in ms
  cacheStats?: {                // Cache statistics (if caching enabled)
    hits: number;
    misses: number;
    hitRate: number;          // Percentage
    totalSizeMB: number;
  };
}
```

## Double-Pass Matcher Pattern

Both engines use the same efficient session allocation pattern:

### Pass 1: Match to Existing
- Try to match work items (URLs) to existing sessions
- Respects proxy requirements and site configurations
- Identifies which existing sessions will be used

### Pass 2: Create and Match
- Terminate excess sessions that won't be used
- Create only the sessions needed for unmatched work
- Re-run matching with all sessions (existing + new)

This pattern ensures:
- Optimal resource usage
- Minimal session creation overhead
- Respect for all system limits
- Support for incremental scaling

## Error Handling

Both engines implement sophisticated error handling:

### Network Errors
- Automatically retried up to `maxRetries` times
- Include: timeouts, connection errors, navigation failures
- Items marked as `failed` after exhausting retries

### Non-Network Errors
- Not retried (likely data/scraper issues)
- Items marked as `invalid`
- Include: scraper errors, missing fields, parsing failures

### Error Isolation
- Errors in one site don't affect others
- Detailed error reporting in results
- Graceful degradation when possible

## CLI Usage

The engines are accessible via CLI commands:

```bash
# Paginate all sites with scraping enabled
npm run scrape paginate

# Paginate specific sites
npm run scrape paginate -- --sites=site1.com,site2.com

# Scrape items from all sites with pending items
npm run scrape items

# Scrape items from specific sites
npm run scrape items -- --sites=site1.com,site2.com

# Use local browser
npm run scrape paginate -- --local-headless
npm run scrape items -- --local-headed

# Adjust limits and settings
npm run scrape paginate -- --instance-limit=20 --max-pages=10
npm run scrape items -- --item-limit=200 --max-retries=3

# Skip saving (for testing)
npm run scrape paginate -- --no-save
npm run scrape items -- --no-save

# Custom cache settings
npm run scrape items -- --cache-size-mb=200 --cache-ttl-seconds=600
```

## Best Practices

1. **Start Small**: Use lower instance limits initially to test
2. **Monitor Resources**: Watch memory usage with large batches
3. **Use Caching**: Keep caching enabled for better performance
4. **Handle Failures**: Check error maps in results for debugging
5. **Incremental Processing**: Use site filters to process incrementally

## Integration

Engines integrate with the broader system:

- **SiteManager**: Provides site configurations and state management
- **SessionManager**: Handles browser session lifecycle
- **Distributor**: Intelligent URL-to-session matching
- **Scrapers**: Site-specific scraping logic
- **ETL API**: Data persistence layer

## Future Enhancements

Potential improvements:
- Progress callbacks for long-running operations
- Parallel site processing (currently sequential)
- Advanced retry strategies (exponential backoff)
- Real-time metrics and monitoring
- API endpoint integration