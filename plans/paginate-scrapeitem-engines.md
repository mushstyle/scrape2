# Paginate and ScrapeItem Engines Plan (Revised)

## Goal
**Create production-ready engines for paginating sites and scraping individual items that can be invoked from CLI, with caching support and proper architectural patterns.**

## Key Requirements
1. No ActiveTask tracking - engines are stateless orchestrators
2. Keep `forceRefresh` pattern for cross-process visibility
3. Both PaginateEngine and ScrapeItemEngine use double-pass matcher pattern
4. Initial implementation is CLI-only for sanity checking
5. Follow strict layered architecture (engines → services → drivers → providers)
6. Include caching like pagination-live.ts example

## Architecture Overview

### Engine Design Pattern
- **PaginateEngine**: Orchestrates pagination across multiple sites using double-pass matcher
- **ScrapeItemEngine**: Orchestrates scraping of individual items using double-pass matcher
- Both engines are stateless classes in `src/engines/`
- Both accept injected SessionManager and SiteManager instances
- Both return results immediately (no persistent task tracking)

### Key Principles
- Engines orchestrate but don't own state
- SiteManager handles all persistent state (partial runs, blocked proxies)
- SessionManager handles session lifecycle
- Distributor handles URL-to-session matching
- Caching improves performance without changing logic

## Implementation Plan

### [ ] 1. Add forceRefresh Support to SiteManager
Update existing methods to support bypassing in-memory cache:
- [ ] `getSitesWithPartialRuns(options?: { forceRefresh?: boolean })`
- [ ] `getBlockedProxies(domain: string, options?: { forceRefresh?: boolean })`
- [ ] `getSiteStatus(domain: string, options?: { forceRefresh?: boolean })`
- [ ] Implementation pattern:
  ```typescript
  async getSitesWithPartialRuns(options?: { forceRefresh?: boolean }): Promise<string[]> {
    if (options?.forceRefresh) {
      // Query database directly via driver
      const runs = await this.scrapeRunsDriver.getActiveRuns();
      return runs.map(r => r.domain);
    }
    // Use in-memory state
    return Array.from(this.partialRuns.keys());
  }
  ```

### [ ] 2. Create PaginateEngine
- [ ] Create `src/engines/paginate-engine.ts`:
  ```typescript
  export interface PaginateOptions {
    sites?: string[];  // If not specified, paginate all sites with scraping enabled
    instanceLimit?: number;  // Default: 10
    maxPages?: number;  // Default: 5
    disableCache?: boolean;  // Cache ON by default
    cacheSizeMB?: number;  // Default: 100
    cacheTTLSeconds?: number;  // Default: 300 (5 minutes)
    noSave?: boolean;  // Save to DB by default
    localHeadless?: boolean;  // Use local browser in headless mode
    localHeaded?: boolean;  // Use local browser in headed mode
    sessionTimeout?: number;  // Session timeout in seconds (browserbase only)
    maxRetries?: number;  // Default: 2 (for network errors)
  }

  export interface PaginateResult {
    success: boolean;
    sitesProcessed: number;
    totalUrls: number;
    urlsBySite: Map<string, string[]>;
    errors: Map<string, string>;
    duration: number;
    cacheStats?: CacheStats;
  }

  export class PaginateEngine {
    constructor(
      private siteManager: SiteManager,
      private sessionManager: SessionManager
    ) {}

    async paginate(options: PaginateOptions): Promise<PaginateResult> {
      // Implementation following pagination-live.ts pattern
    }
  }
  ```

- [ ] Implementation details:
  - [ ] Get sites to process:
    - If sites specified: use those
    - Otherwise: get all sites with scraping enabled from SiteManager
  - [ ] Load site configurations via SiteManager
  - [ ] Collect all start page URLs across sites
  - [ ] Implement double-pass matcher:
    - First pass: Match URLs to existing sessions
    - Terminate unused sessions
    - Calculate new sessions needed
    - Create targeted sessions based on unmatched URLs
    - Pass browserType: 'local' if localHeadless or localHeaded is set
    - Pass headless: true/false based on options
    - Pass timeout if sessionTimeout is specified
    - Second pass: Match all URLs to all sessions
  - [ ] Create RequestCache (enabled by default unless disableCache=true)
  - [ ] Create browsers only for used sessions
  - [ ] Process each URL-session pair:
    - Load scraper for site
    - Create page with cache enabled
    - Paginate using Set for deduplication
    - Retry navigation errors up to maxRetries times
    - Update SiteManager pagination state
  - [ ] Unless noSave is true:
    - Commit partial runs per site
  - [ ] Clean up all resources
  - [ ] Return comprehensive results

### [ ] 3. Create ScrapeItemEngine
- [ ] Create `src/engines/scrape-item-engine.ts`:
  ```typescript
  export interface ScrapeItemOptions {
    sites?: string[];  // If not specified, scrape all sites with pending items
    instanceLimit?: number;  // Default: 10
    itemLimit?: number;  // Max items per site, default: 100
    disableCache?: boolean;  // Cache ON by default
    cacheSizeMB?: number;  // Default: 100
    cacheTTLSeconds?: number;  // Default: 300 (5 minutes)
    noSave?: boolean;  // Save to ETL by default
    localHeadless?: boolean;  // Use local browser in headless mode
    localHeaded?: boolean;  // Use local browser in headed mode
    sessionTimeout?: number;  // Session timeout in seconds (browserbase only)
    maxRetries?: number;  // Default: 2 (for network errors)
  }

  export interface ScrapeItemResult {
    success: boolean;
    itemsScraped: number;
    itemsBySite: Map<string, Item[]>;
    errors: Map<string, string>;
    duration: number;
    cacheStats?: CacheStats;
  }

  export class ScrapeItemEngine {
    constructor(
      private siteManager: SiteManager,
      private sessionManager: SessionManager
    ) {}

    async scrapeItems(options: ScrapeItemOptions): Promise<ScrapeItemResult> {
      // Implementation using double-pass matcher
    }
  }
  ```

- [ ] Implementation details:
  - [ ] Get sites to process:
    - If sites specified: use those
    - Otherwise: get all sites with pending items from scrape runs
  - [ ] For each site:
    - Get pending item URLs from active scrape runs
    - Limit to itemLimit per site
  - [ ] Convert all URLs to ScrapeTargets
  - [ ] Implement double-pass matcher (same pattern as PaginateEngine)
    - Pass browserType: 'local' if localHeadless or localHeaded is set
    - Pass headless: true/false based on options
    - Pass timeout if sessionTimeout is specified
  - [ ] Create RequestCache (enabled by default)
  - [ ] Process each URL-session pair:
    - Load scraper for site
    - Create page with cache enabled
    - Navigate to item URL with retry logic (up to maxRetries for network errors)
    - Call scraper.scrapeItem()
    - Update scrape run status:
      - Mark as done if successful
      - Mark as failed if network error after retries
      - Mark as invalid if other error (no retry)
    - Collect results
  - [ ] Unless noSave is true:
    - Use ETL driver to save items
  - [ ] Clean up all resources
  - [ ] Return results organized by site

### [ ] 4. Create CLI Commands
- [ ] Update `src/cli/commands/scrape.ts`:
  ```typescript
  // New subcommand: scrape paginate
  if (command === 'paginate') {
    const sites = options.sites?.split(',') : undefined;
    const instanceLimit = options.instanceLimit || 10;
    const maxPages = options.maxPages || 5;
    const disableCache = options.disableCache || false;
    const noSave = options.noSave || false;
    const localHeadless = options.localHeadless || false;
    const localHeaded = options.localHeaded || false;
    const sessionTimeout = options.sessionTimeout;
    const maxRetries = options.maxRetries || 2;
    const cacheSizeMB = options.cacheSizeMB || 100;
    const cacheTTLSeconds = options.cacheTTLSeconds || 300;

    const siteManager = new SiteManager();
    const sessionManager = new SessionManager();
    
    await siteManager.loadSites();
    
    const engine = new PaginateEngine(siteManager, sessionManager);
    const result = await engine.paginate({
      sites,  // undefined = all sites
      instanceLimit,
      maxPages,
      disableCache,
      noSave,
      localHeadless,
      localHeaded,
      sessionTimeout,
      maxRetries,
      cacheSizeMB,
      cacheTTLSeconds
    });

    // Display results
    console.log(`Processed ${result.sitesProcessed} sites`);
    console.log(`Collected ${result.totalUrls} URLs`);
    if (!noSave) {
      console.log(`Saved to database`);
    }
    if (result.cacheStats) {
      console.log(`Cache hit rate: ${(result.cacheStats.hits / (result.cacheStats.hits + result.cacheStats.misses) * 100).toFixed(1)}%`);
    }
  }

  // New subcommand: scrape items
  if (command === 'items') {
    const sites = options.sites?.split(',') : undefined;
    const instanceLimit = options.instanceLimit || 10;
    const itemLimit = options.itemLimit || 100;
    const disableCache = options.disableCache || false;
    const noSave = options.noSave || false;
    const localHeadless = options.localHeadless || false;
    const localHeaded = options.localHeaded || false;
    const sessionTimeout = options.sessionTimeout;
    const maxRetries = options.maxRetries || 2;
    const cacheSizeMB = options.cacheSizeMB || 100;
    const cacheTTLSeconds = options.cacheTTLSeconds || 300;

    const siteManager = new SiteManager();
    const sessionManager = new SessionManager();
    
    await siteManager.loadSites();
    
    const engine = new ScrapeItemEngine(siteManager, sessionManager);
    const result = await engine.scrapeItems({
      sites,  // undefined = all sites with pending items
      instanceLimit,
      itemLimit,
      disableCache,
      noSave,
      localHeadless,
      localHeaded,
      sessionTimeout,
      maxRetries,
      cacheSizeMB,
      cacheTTLSeconds
    });

    console.log(`Scraped ${result.itemsScraped} items`);
    for (const [site, items] of result.itemsBySite) {
      console.log(`  ${site}: ${items.length} items`);
    }
    if (!noSave) {
      console.log(`Saved to ETL API`);
    }
    if (result.errors.size > 0) {
      console.log(`Failed: ${result.errors.size} items`);
    }
  }
  ```

- [ ] Add command documentation:
  ```bash
  # Paginate all sites (Browserbase by default, cache ON, save ON)
  npm run scrape paginate  # instanceLimit=10, maxPages=5 by default

  # Paginate specific sites
  npm run scrape paginate -- --sites=site1.com,site2.com

  # Scrape items from all sites with pending items
  npm run scrape items  # instanceLimit=10, itemLimit=100 by default

  # Scrape items from specific sites
  npm run scrape items -- --sites=site1.com,site2.com

  # Use local browser in headless mode
  npm run scrape paginate -- --sites=site1.com --local-headless
  npm run scrape items -- --sites=site1.com --local-headless

  # Use local browser in headed mode (visible browser)
  npm run scrape paginate -- --sites=site1.com --local-headed
  npm run scrape items -- --sites=site1.com --local-headed

  # Set session timeout for Browserbase (seconds)
  npm run scrape paginate -- --session-timeout=120
  npm run scrape items -- --session-timeout=120

  # Adjust retry count for network errors (default: 2)
  npm run scrape items -- --max-retries=3

  # Skip saving (for testing)
  npm run scrape paginate -- --sites=site1.com --no-save
  npm run scrape items -- --sites=site1.com --no-save

  # Disable cache (not recommended)
  npm run scrape paginate -- --sites=site1.com --disable-cache

  # Custom cache settings
  npm run scrape items -- --cache-size-mb=200 --cache-ttl-seconds=600
  ```

### [ ] 5. Testing Strategy
- [ ] Create `src/engines/__tests__/paginate-engine.test.ts`:
  - [ ] Test double-pass matcher integration
  - [ ] Test cache behavior when enabled/disabled
  - [ ] Test error handling (site failures don't affect others)
  - [ ] Test resource cleanup
  - [ ] Mock SessionManager and SiteManager

- [ ] Create `src/engines/__tests__/scrape-item-engine.test.ts`:
  - [ ] Test URL grouping by domain
  - [ ] Test double-pass matcher for items
  - [ ] Test item scraping with mock scrapers
  - [ ] Test ETL saving when enabled
  - [ ] Test error collection

- [ ] Integration tests:
  - [ ] Test CLI commands with test sites
  - [ ] Verify memory usage with large batches
  - [ ] Test session reuse across runs

### [ ] 6. Documentation Updates
- [ ] Create `docs/engines.md`:
  ```markdown
  # Engines

  Engines are the top-level orchestrators in our architecture. They coordinate complex workflows using services and core logic.

  ## PaginateEngine

  Orchestrates pagination across multiple sites using the double-pass matcher pattern.

  ### Usage
  ```typescript
  const engine = new PaginateEngine(siteManager, sessionManager);
  const result = await engine.paginate({
    sites: ['site1.com', 'site2.com'],
    instanceLimit: 10,
    maxPages: 5,
    enableCache: true
  });
  ```

  ### How it Works
  1. Collects start pages from all sites
  2. Uses double-pass matcher to efficiently assign URLs to sessions
  3. Paginates each site independently
  4. Tracks progress via SiteManager's partial run system
  5. Returns aggregated results

  ## ScrapeItemEngine

  Orchestrates scraping of individual items using the double-pass matcher pattern.

  ### Usage
  ```typescript
  const engine = new ScrapeItemEngine(siteManager, sessionManager);
  const result = await engine.scrapeItems({
    urls: ['url1', 'url2', 'url3'],
    instanceLimit: 5,
    enableCache: true,
    saveToETL: true
  });
  ```

  ### Double-Pass Matcher

  Both engines use the same efficient session allocation pattern:
  - **Pass 1**: Try to match work to existing sessions
  - **Pass 2**: Create only the sessions needed for unmatched work

  This ensures optimal resource usage and supports incremental scaling.
  ```

- [ ] Update `README.md` with new CLI commands
- [ ] Add examples showing typical usage patterns

## Key Design Decisions

### No ActiveTask System
- Engines return results immediately
- No persistent task tracking needed for CLI usage
- Simpler implementation, easier to debug
- Can add task tracking later if needed for API

### Double-Pass for Everything
- Consistent pattern across both engines
- Efficient session reuse
- Respects all system limits
- Proven pattern from pagination-live.ts

### Stateless Engines
- Engines don't maintain state between calls
- All state in SessionManager and SiteManager
- Enables easy testing and concurrent usage
- Follows architectural principles

### CLI-First Implementation
- Start with CLI for immediate testing
- No API endpoints initially
- Can verify behavior interactively
- API integration can come later

## Success Criteria

1. **Functionality**
   - [ ] Can paginate multiple sites from CLI
   - [ ] Can scrape individual items from CLI
   - [ ] Caching improves performance by >30%
   - [ ] Errors in one site don't affect others

2. **Architecture**
   - [ ] Strict layer separation maintained
   - [ ] Engines only orchestrate, don't implement
   - [ ] State properly managed by services
   - [ ] Clean resource management

3. **Performance**
   - [ ] Session reuse works correctly
   - [ ] Memory usage stays reasonable
   - [ ] Cache statistics show effectiveness
   - [ ] Parallel processing where appropriate

4. **Usability**
   - [ ] Clear CLI output
   - [ ] Helpful error messages
   - [ ] Progress indication
   - [ ] Easy to debug issues

## Implementation Order

1. Add forceRefresh support to SiteManager (foundation)
2. Create PaginateEngine (simpler, proven pattern)
3. Create ScrapeItemEngine (builds on paginate patterns)
4. Add CLI commands (enables testing)
5. Write comprehensive tests
6. Document everything

This approach gives us working, testable engines quickly while maintaining architectural integrity and setting up for future API integration.