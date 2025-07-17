# Sites and Sessions: The Core Framework

This document explains how to properly use the three core components of the scraping framework: **SiteManager**, **SessionManager**, and the **distributor**. These are the ONLY components you need to interact with for most scraping tasks.

## Core Architecture

```
SiteManager (sites & configs) + SessionManager (browser sessions) → Distributor (matches work to resources)
```

## Key Principles

1. **SessionManager owns the session pool** - Create sessions based on instance limit, NOT per-site
   - **Why**: Sessions are expensive resources (browser instances). Creating one per site wastes resources and doesn't scale. A pool allows efficient reuse across multiple sites.

2. **Distributor assigns work** - It intelligently matches URLs to available sessions
   - **Why**: The distributor knows about proxy compatibility, blocked proxies, and session availability. Manual assignment would duplicate this complex logic and lead to errors.

3. **Sessions are shared resources** - Don't create site-specific sessions; let the distributor decide
   - **Why**: A session can scrape any compatible site. Locking sessions to sites reduces flexibility and efficiency. The distributor ensures proper matching based on proxy requirements.

## Common Mistakes to Avoid

### ❌ DON'T: Create sessions per site
```typescript
// WRONG - Creating sessions for each site
for (const site of sites) {
  const session = await sessionManager.createSession({ domain: site });
}
```

**Why this is wrong**: 
- Creates more sessions than needed (if sites < instanceLimit)
- Creates sessions sequentially (slow)
- Doesn't allow session reuse across sites
- Ignores the instance limit parameter

### ✅ DO: Create a session pool
```typescript
// RIGHT - Create a pool of sessions that can be used for any site
const sessionOptions = await Promise.all(
  Array.from({ length: instanceLimit }, async (_, i) => {
    // Rotate through sites or use a strategy for proxy selection
    const siteForProxy = sites[i % sites.length];
    const proxy = await siteManager.getProxyForDomain(siteForProxy);
    return { domain: siteForProxy, proxy };
  })
);

// Create all sessions in parallel
const sessions = await sessionManager.createSession(sessionOptions) as Session[];
```

**Why this is correct**:
- Creates exactly `instanceLimit` sessions (respects resource limits)
- Creates all sessions in parallel (fast)
- Sessions can be reused for any compatible site
- Proxy selection is distributed across sites for better coverage

### ❌ DON'T: Manually determine session limits
```typescript
// WRONG - Don't try to calculate this yourself
const effectiveLimit = Math.min(
  instanceLimit,
  siteSessionLimit,
  startPages.length
);
```

### ✅ DO: Let SessionManager handle limits
```typescript
// RIGHT - SessionManager enforces its instance limit
const sessionManager = new SessionManager({ sessionLimit: instanceLimit });
// It will throw if you try to create too many sessions
```

## Complete Example: Multi-Site Pagination

Here's the correct way to paginate multiple sites:

```typescript
import { SiteManager } from '../src/services/site-manager.js';
import { SessionManager } from '../src/services/session-manager.js';
import { itemsToSessions } from '../src/core/distributor.js';
import { urlsToScrapeTargets } from '../src/utils/scrape-target-utils.js';
import { createBrowserFromSession } from '../src/drivers/browser.js';
import { loadScraper } from '../src/drivers/scraper-loader.js';

async function paginateMultipleSites(sites: string[], instanceLimit: number) {
  // 1. Initialize managers
  const siteManager = new SiteManager();
  const sessionManager = new SessionManager({ sessionLimit: instanceLimit });
  
  // 2. Load site configurations
  await siteManager.loadSites();
  
  // 3. Create session pool ONCE (not per site!)
  const sessionOptions = await Promise.all(
    Array.from({ length: instanceLimit }, async (_, i) => {
      const siteForProxy = sites[i % sites.length];
      const proxy = await siteManager.getProxyForDomain(siteForProxy);
      return { domain: siteForProxy, proxy };
    })
  );
  
  const sessions = await sessionManager.createSession(sessionOptions) as Session[];
  
  // 4. Create browsers from sessions (CRITICAL STEP!)
  const sessionData = await Promise.all(
    sessions.map(async (session, i) => {
      const { browser, createContext } = await createBrowserFromSession(session);
      const context = await createContext();
      return {
        session,
        browser,
        context,
        sessionInfo: {
          id: `session-${i}`,
          proxyType: sessionOptions[i].proxy?.type || 'none',
          proxyId: sessionOptions[i].proxy?.id,
          proxyGeo: sessionOptions[i].proxy?.geo
        }
      };
    })
  );
  
  // 5. Process each site
  for (const site of sites) {
    // Get site config with blocked proxies
    const siteConfigs = await siteManager.getSiteConfigsWithBlockedProxies();
    const siteConfig = siteConfigs.find(c => c.domain === site);
    
    // Convert URLs to targets
    const targets = urlsToScrapeTargets(siteConfig.startPages);
    
    // Load scraper for the site
    const scraper = await loadScraper(site);
    
    // 6. Let distributor match work to sessions
    const urlSessionPairs = itemsToSessions(
      targets,
      sessionData.map(s => s.sessionInfo),
      [siteConfig] // Pass site config so distributor can respect blocked proxies
    );
    
    // 7. Process the pairs
    for (const pair of urlSessionPairs) {
      const session = sessionData.find(s => s.sessionInfo.id === pair.sessionId);
      const page = await session.context.newPage();
      
      // Navigate to start page
      await page.goto(pair.url);
      
      // Pagination loop
      let pageCount = 1;
      const maxPages = 5; // Limit for safety
      const allUrls = [];
      
      // Get URLs from first page
      const firstPageUrls = await scraper.getItemUrls(page);
      allUrls.push(...Array.from(firstPageUrls));
      
      // Navigate through additional pages
      while (pageCount < maxPages) {
        const hasMore = await scraper.paginate(page);
        if (!hasMore) break;
        
        pageCount++;
        const urls = await scraper.getItemUrls(page);
        allUrls.push(...Array.from(urls));
      }
      
      await page.close();
    }
  }
}
```

## SessionManager Usage

### Creating Sessions

SessionManager now supports parallel creation:

```typescript
// Single session (backward compatible)
const session = await sessionManager.createSession({ domain: 'example.com', proxy });

// Multiple sessions in parallel (much faster!)
const sessions = await sessionManager.createSession([
  { domain: 'site1.com', proxy: proxy1 },
  { domain: 'site2.com', proxy: proxy2 },
  { domain: 'site3.com', proxy: proxy3 }
]) as Session[];
```

### IMPORTANT: Sessions vs Browsers

**SessionManager creates Session objects, NOT browsers!**

**Why this distinction matters**:
- Separation of concerns: SessionManager handles resource allocation, not browser creation
- Flexibility: Different providers (Browserbase, local) have different browser creation methods
- Lazy initialization: Browsers are only created when needed, saving resources

A `Session` is just connection information:
- For Browserbase: contains `connectUrl` to connect to remote browser
- For local: contains a Playwright browser instance

**You MUST create browsers from sessions:**

```typescript
import { createBrowserFromSession } from '../src/drivers/browser.js';

// Create browser from session
const { browser, createContext } = await createBrowserFromSession(session);

// Create a context
const context = await createContext();

// Now you can create pages
const page = await context.newPage();
```

### Common Mistake: Forgetting to Create Browsers

```typescript
// ❌ WRONG - This will fail with "Cannot read properties of undefined"
const sessions = await sessionManager.createSession(options);
const page = await sessions[0].context.newPage(); // context doesn't exist!

// ✅ RIGHT - Create browsers from sessions
const sessions = await sessionManager.createSession(options);
const sessionData = await Promise.all(
  sessions.map(async session => {
    const { browser, createContext } = await createBrowserFromSession(session);
    const context = await createContext();
    return { browser, context };
  })
);
const page = await sessionData[0].context.newPage(); // Now it works!
```

### Instance Limit

The instance limit is the maximum number of concurrent browser sessions:

```typescript
// Set at initialization
const sessionManager = new SessionManager({ sessionLimit: 10 });

// SessionManager enforces this limit automatically
// Throws error if you try to exceed it
```

## SiteManager Usage

### Key Methods for Sessions

```typescript
// Get proxy for a domain (respects proxy strategy)
const proxy = await siteManager.getProxyForDomain('example.com');

// Get site configs with blocked proxies (for distributor)
const configs = await siteManager.getSiteConfigsWithBlockedProxies();

// Get session limit for a domain (from site config)
const limit = await siteManager.getSessionLimitForDomain('example.com');
```

### Robust Scrape Runs

SiteManager now supports partial run tracking per site:

```typescript
// Start tracking pagination
await siteManager.startPagination('example.com', startPages);

// Update progress
siteManager.updatePaginationState(startPageUrl, {
  collectedUrls: urls,
  completed: true
});

// Commit when done (only if all succeeded)
const run = await siteManager.commitPartialRun('example.com');
```

## Distributor Usage

The distributor (`itemsToSessions`) is the intelligent matchmaker:

```typescript
import { itemsToSessions } from '../src/core/distributor.js';

// Prepare inputs
const targets = urlsToScrapeTargets(urls); // Convert URLs to ScrapeTargets
const sessionInfos = /* array of SessionInfo objects */;
const siteConfigs = /* array of site configs with blockedProxies */;

// Get matches
const urlSessionPairs = itemsToSessions(targets, sessionInfos, siteConfigs);

// Each pair has: { url: string, sessionId: string }
```

### How the Distributor Works

1. **Filters out completed targets** (`done === true`)
   - **Why**: Avoids reprocessing already scraped URLs

2. **Respects blocked proxies** from site configs
   - **Why**: Datacenter proxies can get temporarily blocked by sites. Using blocked proxies wastes time and resources.

3. **Matches URLs to compatible sessions**
   - **Why**: Not all sessions can scrape all sites (e.g., proxy geo restrictions). The distributor ensures compatibility.

4. **Returns at most N pairs** where N = number of sessions
   - **Why**: Each session can only process one URL at a time. Returning more would create a backlog.

5. **Each session is used at most once**
   - **Why**: Prevents race conditions and ensures parallel processing efficiency.

## Proxy Management

### Getting Proxies

Always get proxies from SiteManager:

```typescript
// ✅ RIGHT
const proxy = await siteManager.getProxyForDomain('example.com');

// ❌ WRONG - Don't select proxies manually
const proxy = myCustomProxySelection();
```

### Blocked Proxies

The system automatically manages proxy blocklists:

```typescript
// Add failed proxy to blocklist (datacenter only)
await siteManager.addProxyToBlocklist('example.com', proxyId, errorMessage);

// Get current blocked proxies (auto-cleaned based on cooldown)
const blocked = await siteManager.getBlockedProxies('example.com');

// Pass to distributor via getSiteConfigsWithBlockedProxies()
const configs = await siteManager.getSiteConfigsWithBlockedProxies();
```

## Complete Workflow

1. **Initialize** managers with appropriate limits
2. **Load** site configurations
3. **Create** session pool based on instance limit
4. **For each site:**
   - Get site config with blocked proxies
   - Convert URLs to targets
   - Use distributor to match URLs to sessions
   - Process the matched pairs
5. **Track** progress with partial run methods
6. **Commit** successful runs to database

## CLI Parameters

Follow the naming convention where CLI params match internal variables:

```bash
# Instance limit for SessionManager
--instance-limit=10  # → sessionManager = new SessionManager({ sessionLimit: 10 })

# Sites to process
--sites=site1.com,site2.com
```

## Testing Your Implementation

To verify you're using the framework correctly:

1. Sessions should be created with proper proxy info (not "no-proxy")
2. Session creation should be fast (parallel, not sequential)
3. The distributor should handle all URL-to-session matching
4. Sites should process independently (one failure doesn't affect others)

## Understanding Scraper API

Scrapers have a specific API for pagination:

```typescript
interface Scraper {
  // Get URLs from the current page (returns a Set)
  getItemUrls(page: Page): Promise<Set<string>>;
  
  // Navigate to next page and return if more pages exist
  paginate(page: Page): Promise<boolean>;
  
  // Scrape individual item details
  scrapeItem(page: Page, url: string): Promise<Item>;
}
```

**Why this API design**:
- **Separation of concerns**: Getting URLs and navigating are different operations
- **Stateful navigation**: The `paginate` method modifies the page state (navigates to next page)
- **Boolean return**: Simple signal for "more pages exist" without coupling to specific pagination implementations
- **Reusable page object**: Keeps the same browser context throughout pagination, maintaining cookies/session

### Correct Pagination Pattern

```typescript
// Navigate to start page
await page.goto(startUrl);

const allUrls = [];
let pageCount = 1;
const maxPages = 5;

// Always get URLs from current page first
const firstPageUrls = await scraper.getItemUrls(page);
allUrls.push(...Array.from(firstPageUrls));

// Then paginate through additional pages
while (pageCount < maxPages) {
  const hasMore = await scraper.paginate(page);
  if (!hasMore) break;
  
  pageCount++;
  const urls = await scraper.getItemUrls(page);
  allUrls.push(...Array.from(urls));
}
```

**Why this pattern**:
- **Get URLs before paginating**: The first page already has items - don't skip them!
- **Check hasMore before continuing**: Avoids unnecessary navigation attempts
- **Use maxPages limit**: Prevents infinite loops on sites with pagination bugs
- **Reuse the same page object**: Maintains session state and is more efficient than creating new pages

## Common Implementation Mistakes (Learned the Hard Way)

These are real mistakes made during implementation that you should avoid:

### 1. Not Using the Distributor
**Mistake**: Manually assigning URLs to sessions
**Why it failed**: Missing proxy compatibility checks, blocked proxy filtering, and intelligent distribution logic
**Lesson**: Always use `itemsToSessions()` - it handles all the complex matching logic

### 2. Creating Browsers Wrong
**Mistake**: Expecting `createBrowserFromSession` to return `{ browser, context }`
**Why it failed**: It actually returns `{ browser, createContext }` - you must call `createContext()`
**Lesson**: Always check the actual API, not assumptions. Reference `verify:paginate` for working examples.

### 3. Sequential Session Creation
**Mistake**: Creating sessions one by one in a loop
**Why it failed**: Extremely slow - each session takes 2-3 seconds to create
**Lesson**: Use the array syntax for parallel creation - 10x faster!

### 4. Misunderstanding Scraper API
**Mistake**: Expecting `paginate()` to return URLs
**Why it failed**: `paginate()` returns a boolean - it navigates the page, doesn't collect URLs
**Lesson**: Use `getItemUrls()` to collect, `paginate()` to navigate

### 5. Not Reading Architecture Docs
**Mistake**: Trying to add browser creation methods to SessionManager
**Why it failed**: Violates layered architecture - services can't use drivers directly
**Lesson**: Respect the architecture layers. Read `docs/architecture.md` first!

## Summary

- **SessionManager** = Manages the pool of browser sessions (NOT browser creation!)
- **SiteManager** = Provides site configs, proxies, and tracks progress
- **Distributor** = Intelligently assigns work to available resources
- **createBrowserFromSession** = The ONLY way to create browsers from sessions

Let these components work together as designed. When in doubt, check how `verify:paginate` does it - it's the reference implementation!