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

## URL Deduplication

When paginating, proper URL deduplication is critical:

### Within-Page Deduplication
Scrapers return a `Set<string>` from `getItemUrls()`, which automatically handles duplicates on a single page.

### Cross-Page Deduplication
**YOU are responsible for deduplication across pages**:

```typescript
// ❌ WRONG - Accumulates duplicates
const pageUrls: string[] = [];
const firstPageUrls = await scraper.getItemUrls(page);
firstPageUrls.forEach(url => pageUrls.push(url)); // 36 items

await scraper.paginate(page);
const secondPageUrls = await scraper.getItemUrls(page);  
secondPageUrls.forEach(url => pageUrls.push(url)); // Now 72 items, but likely has duplicates!

// ✅ RIGHT - Uses Set for automatic deduplication
const uniqueUrls = new Set<string>();
const firstPageUrls = await scraper.getItemUrls(page);
firstPageUrls.forEach(url => uniqueUrls.add(url)); // 36 unique

await scraper.paginate(page);
const beforeCount = uniqueUrls.size;
const secondPageUrls = await scraper.getItemUrls(page);
secondPageUrls.forEach(url => uniqueUrls.add(url)); 
const newItems = uniqueUrls.size - beforeCount; // Shows exactly how many new items
```

### Cross-Site Deduplication
When processing multiple sites, check for shared URLs:

```typescript
const urlToSite = new Map<string, string>();

for (const target of targets) {
  if (!urlToSite.has(target.url)) {
    urlToSite.set(target.url, site);
    // Process this URL
  } else {
    // Skip - already assigned to another site
    log.debug(`Duplicate URL ${target.url} already assigned to ${urlToSite.get(target.url)}`);
  }
}
```

## Double-Pass Matcher Pattern

For production scraping, use the double-pass matcher algorithm (see `docs/double-pass-matcher.md` and `examples/pagination-live.ts`):

### The Problem It Solves
- SessionManager might have a limit (e.g., 5 sessions max)
- Creating all sessions upfront wastes resources if not all are needed
- Existing sessions from previous runs should be reused
- Different URLs need different proxy types

### How It Works

**Pass 1: Use What You Have**
1. Get existing sessions from SessionManager
2. Try to match URLs to existing sessions using the distributor
3. Terminate any sessions that won't be used

**Pass 2: Create What You Need**
1. Calculate how many new sessions are needed (respecting limits)
2. Analyze unmatched URLs to determine proxy requirements
3. Create targeted sessions with the right proxy types
4. Run distributor again with all sessions (existing + new)

### Key Implementation Details
```typescript
// IMPORTANT: Convert Sessions to SessionInfo for distributor
const existingSessionData = existingSessions.map((session, i) => ({
  session,
  sessionInfo: {
    id: `existing-${i}`,
    proxyType: session.proxy?.type || 'none',
    proxyId: session.proxy?.id,
    proxyGeo: session.proxy?.geo
  }
}));

// IMPORTANT: Only create browsers for sessions that will be used
const usedSessionIds = new Set(finalPairs.map(p => p.sessionId));
await Promise.all(
  Array.from(usedSessionIds).map(async sessionId => {
    const sessionData = sessionDataMap.get(sessionId);
    if (sessionData && !sessionData.browser) {
      const { browser, createContext } = await createBrowserFromSession(sessionData.session);
      sessionData.browser = browser;
      sessionData.context = await createContext();
    }
  })
);
```

**Benefits**:
- Reuses existing sessions (cost-efficient)
- Only creates sessions that will be used
- Respects all limits (SessionManager and instance limits)
- Can scale up to instanceLimit over multiple runs
- Zero wasted resources

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

### ❌ DON'T: Create all sessions upfront (Old Pattern)
```typescript
// OLD PATTERN - Creates all sessions even if not needed
const sessionOptions = await Promise.all(
  Array.from({ length: instanceLimit }, async (_, i) => {
    const siteForProxy = sites[i % sites.length];
    const proxy = await siteManager.getProxyForDomain(siteForProxy);
    return { domain: siteForProxy, proxy };
  })
);
const sessions = await sessionManager.createSession(sessionOptions);
```

**Why this is suboptimal**:
- Creates sessions that might not be used
- Doesn't reuse existing sessions
- Can hit SessionManager limits unnecessarily
- Wastes resources

### ✅ DO: Use Double-Pass Matcher Pattern
```typescript
// BEST PRACTICE - Only create sessions as needed
// Step 1: Get existing sessions
const existingSessions = await sessionManager.getActiveSessions();

// Step 2: Try to match URLs to existing sessions
const firstPassPairs = targetsToSessions(targets, existingSessions, siteConfigs);

// Step 3: Terminate unused sessions
const usedSessionIds = new Set(firstPassPairs.map(p => p.sessionId));
const unusedSessions = existingSessions.filter(s => !usedSessionIds.has(s.id));
await Promise.all(unusedSessions.map(s => sessionManager.destroySession(s.id)));

// Step 4: Only create new sessions if needed
const sessionsNeeded = Math.min(
  instanceLimit - firstPassPairs.length,
  targets.length - firstPassPairs.length
);

if (sessionsNeeded > 0) {
  // Analyze unmatched URLs to determine proxy requirements
  const unmatchedTargets = targets.filter(
    target => !firstPassPairs.find(pair => pair.url === target.url)
  );
  
  // Create sessions based on actual requirements
  const newSessionRequests = [];
  for (const target of unmatchedTargets.slice(0, sessionsNeeded)) {
    const domain = new URL(target.url).hostname;
    const proxy = await siteManager.getProxyForDomain(domain);
    newSessionRequests.push({ domain, proxy });
  }
  
  const newSessions = await Promise.all(
    newSessionRequests.map(req => sessionManager.createSession(req))
  );
  
  // Run distributor again with all sessions
  const allSessions = [...existingSessions, ...newSessions];
  const finalPairs = targetsToSessions(targets, allSessions, siteConfigs);
}
```

**Why this is correct**:
- Reuses existing sessions first (efficient)
- Only creates sessions that will actually be used
- Respects both SessionManager and instance limits
- Can scale up to instanceLimit over multiple runs
- Terminates excess sessions to free resources

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

Here's the production-ready way to paginate multiple sites using the double-pass matcher pattern (see `examples/pagination-live.ts` for full implementation):

```typescript
import { SiteManager } from '../src/services/site-manager.js';
import { SessionManager } from '../src/services/session-manager.js';
import { targetsToSessions } from '../src/core/distributor.js';
import { urlsToScrapeTargets } from '../src/utils/scrape-target-utils.js';
import { createBrowserFromSession } from '../src/drivers/browser.js';
import { loadScraper } from '../src/drivers/scraper-loader.js';

async function paginateMultipleSites(sites: string[], instanceLimit: number) {
  // 1. Initialize managers
  const siteManager = new SiteManager();
  const sessionManager = new SessionManager();
  
  // 2. Load site configurations
  await siteManager.loadSites();
  
  // 3. Collect all start page URLs with deduplication
  const allTargets: ScrapeTarget[] = [];
  const urlToSite = new Map<string, string>();
  
  for (const site of sites) {
    const siteConfig = siteManager.getSite(site);
    if (!siteConfig?.config.startPages?.length) continue;
    
    // Start pagination tracking
    await siteManager.startPagination(site, siteConfig.config.startPages);
    
    // Deduplicate URLs across sites
    const targets = urlsToScrapeTargets(siteConfig.config.startPages);
    for (const target of targets) {
      if (!urlToSite.has(target.url)) {
        allTargets.push(target);
        urlToSite.set(target.url, site);
      }
    }
  }
  
  // 4. Double-pass matcher pattern
  const existingSessions = await sessionManager.getActiveSessions();
  const sessionDataMap = new Map<string, SessionWithBrowser>();
  
  // Convert existing sessions to proper format
  const existingSessionData = existingSessions.map((session, i) => {
    const sessionInfo = {
      id: `existing-${i}`,
      proxyType: session.proxy?.type || 'none',
      proxyId: session.proxy?.id,
      proxyGeo: session.proxy?.geo
    };
    const data = { session, sessionInfo };
    sessionDataMap.set(sessionInfo.id, data);
    return data;
  });
  
  // First pass - match with existing sessions
  const siteConfigs = await siteManager.getSiteConfigsWithBlockedProxies();
  const relevantConfigs = siteConfigs.filter(c => sites.includes(c.domain));
  const targetsToProcess = allTargets.slice(0, instanceLimit);
  
  const firstPassPairs = targetsToSessions(
    targetsToProcess,
    existingSessionData.map(s => s.sessionInfo),
    relevantConfigs
  );
  
  // Terminate unused sessions
  const usedIds = new Set(firstPassPairs.map(p => p.sessionId));
  const unusedSessions = existingSessionData.filter(s => !usedIds.has(s.sessionInfo.id));
  await Promise.all(unusedSessions.map(s => sessionManager.destroySession(s.session.id)));
  
  // Create new sessions only if needed
  const sessionsNeeded = Math.min(
    instanceLimit - firstPassPairs.length,
    targetsToProcess.length - firstPassPairs.length
  );
  
  let finalPairs = firstPassPairs;
  
  if (sessionsNeeded > 0) {
    // Analyze unmatched URLs
    const unmatchedTargets = targetsToProcess.filter(
      t => !firstPassPairs.find(p => p.url === t.url)
    );
    
    // Create sessions based on requirements
    const newSessionRequests = [];
    for (const target of unmatchedTargets.slice(0, sessionsNeeded)) {
      const site = urlToSite.get(target.url);
      const proxy = await siteManager.getProxyForDomain(site);
      newSessionRequests.push({ domain: site, proxy });
    }
    
    const newSessions = await Promise.all(
      newSessionRequests.map(req => sessionManager.createSession(req))
    );
    
    // Add to tracking
    newSessions.forEach((session, i) => {
      const req = newSessionRequests[i];
      const sessionInfo = {
        id: `new-${i}`,
        proxyType: req.proxy?.type || 'none',
        proxyId: req.proxy?.id,
        proxyGeo: req.proxy?.geo
      };
      const data = { session, sessionInfo };
      sessionDataMap.set(sessionInfo.id, data);
      existingSessionData.push(data);
    });
    
    // Second pass with all sessions
    finalPairs = targetsToSessions(
      targetsToProcess,
      existingSessionData.map(s => s.sessionInfo),
      relevantConfigs
    );
  }
  
  // 5. Create browsers only for sessions that will be used
  const usedSessionIds = new Set(finalPairs.map(p => p.sessionId));
  await Promise.all(
    Array.from(usedSessionIds).map(async sessionId => {
      const sessionData = sessionDataMap.get(sessionId);
      if (sessionData && !sessionData.browser) {
        const { browser, createContext } = await createBrowserFromSession(sessionData.session);
        sessionData.browser = browser;
        sessionData.context = await createContext();
      }
    })
  );
  
  // 6. Process URL-session pairs
  await Promise.all(finalPairs.map(async (pair) => {
    const sessionData = sessionDataMap.get(pair.sessionId);
    const site = urlToSite.get(pair.url);
    
    const scraper = await loadScraper(site);
    const page = await sessionData.context.newPage();
    
    await page.goto(pair.url, { waitUntil: 'domcontentloaded' });
    
    // Pagination with proper deduplication
    const uniqueUrls = new Set<string>();
    let currentPage = 1;
    const maxPages = 5;
    
    // First page
    const firstPageUrls = await scraper.getItemUrls(page);
    firstPageUrls.forEach(url => uniqueUrls.add(url));
    
    // Additional pages
    while (currentPage < maxPages) {
      const hasMore = await scraper.paginate(page);
      if (!hasMore) break;
      
      currentPage++;
      const urls = await scraper.getItemUrls(page);
      urls.forEach(url => uniqueUrls.add(url));
    }
    
    // Update pagination state
    siteManager.updatePaginationState(pair.url, {
      collectedUrls: Array.from(uniqueUrls),
      completed: true
    });
    
    await page.close();
  }));
  
  // 7. Commit partial runs
  for (const site of new Set(urlToSite.values())) {
    await siteManager.commitPartialRun(site);
  }
  
  // 8. Cleanup
  for (const sessionData of sessionDataMap.values()) {
    if (sessionData.browser) {
      await sessionData.context?.close();
      await sessionData.browser.close();
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

The distributor (`targetsToSessions`) is the intelligent matchmaker:

```typescript
import { targetsToSessions } from '../src/core/distributor.js';

// Prepare inputs
const targets = urlsToScrapeTargets(urls); // Convert URLs to ScrapeTargets
const sessionInfos = /* array of SessionInfo objects */;
const siteConfigs = /* array of site configs with blockedProxies */;

// Get matches
const urlSessionPairs = targetsToSessions(targets, sessionInfos, siteConfigs);

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
**Lesson**: Always use `targetsToSessions()` - it handles all the complex matching logic

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