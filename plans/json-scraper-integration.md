# JSON Scraper Integration Plan

## Goal
Modify `npm run scrape items` to automatically detect and use JSON scrapers when a site is configured as using JSON data instead of HTML.

## Current State
- JSON scrapers exist in `/src/scrapers-json/` with `scrapeItem(json, options)` function
- HTML scrapers exist in `/src/scrapers/` with `scrapeItem(page, url, options)` function  
- `ScrapeItemEngine` currently only loads HTML scrapers
- Sites have SiteConfig but no indicator for scraper type

## Implementation Steps

### 1. Add Scraper Type to SiteConfig
Add to `/src/types/site-config-types.ts`:
```typescript
export interface SiteConfig {
    // ... existing fields
    scraperType?: 'html' | 'json';  // Default: 'html'
}
```

### 2. Update ScrapeItemEngine
Modify `/src/engines/scrape-item-engine.ts` to:
1. Check site config for `scraperType`
2. If `json`, load JSON scraper from `/src/scrapers-json/`
3. Fetch JSON data from URL instead of using browser
4. Call JSON scraper's `scrapeItem(json, options)`

### 3. Add JSON Data Fetching
For JSON scrapers, instead of browser navigation:
1. Use fetch() or similar to get JSON from URL
2. Parse response as JSON
3. Pass to JSON scraper

### 4. Update Scraper Loader
Create new function or extend `loadScraper()` to handle both types:
```typescript
// Option 1: New function
loadJsonScraper(domain: string): JsonScraper

// Option 2: Make existing function generic
loadScraper(domain: string, type: 'html' | 'json'): Scraper | JsonScraper
```

## Usage Example
```bash
# Site configured with scraperType: 'json' in db/sites.json
npm run scrape items --sites shop.diesel.com

# Engine detects JSON type, loads JSON scraper, fetches JSON data
```

## Benefits
- Seamless integration - same CLI command works for both HTML and JSON
- Automatic detection based on site configuration
- No need for separate commands or manual specification
- Unified item scraping workflow

## Testing
1. Add `scraperType: 'json'` to shop.diesel.com config
2. Run `npm run scrape items --sites shop.diesel.com`
3. Verify it uses JSON scraper instead of HTML scraper
4. Confirm items are scraped correctly with S3 uploads