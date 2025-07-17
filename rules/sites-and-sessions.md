# Sites and Sessions: The Core Framework

This document explains how to properly use the three core components of the scraping framework: **SiteManager**, **SessionManager**, and the **distributor**. These are the ONLY components you need to interact with for most scraping tasks.

## Core Architecture

```
SiteManager (sites & configs) + SessionManager (browser sessions) → Distributor (matches work to resources)
```

## Key Principles

1. **SessionManager owns the session pool** - Create sessions based on instance limit, NOT per-site
2. **Distributor assigns work** - It intelligently matches URLs to available sessions
3. **Sessions are shared resources** - Don't create site-specific sessions; let the distributor decide

## Common Mistakes to Avoid

### ❌ DON'T: Create sessions per site
```typescript
// WRONG - Creating sessions for each site
for (const site of sites) {
  const session = await sessionManager.createSession({ domain: site });
}
```

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
      const { browser, context } = await createBrowserFromSession(session);
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
    
    // 6. Let distributor match work to sessions
    const urlSessionPairs = itemsToSessions(
      targets,
      sessionInfos,
      [siteConfig] // Pass site config so distributor can respect blocked proxies
    );
    
    // 7. Process the pairs
    for (const pair of urlSessionPairs) {
      const session = sessions[sessionInfos.findIndex(s => s.id === pair.sessionId)];
      const { browser, context } = await createBrowserFromSession(session);
      // ... do pagination with browser
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

A `Session` is just connection information:
- For Browserbase: contains `connectUrl` to connect to remote browser
- For local: contains a Playwright browser instance

**You MUST create browsers from sessions:**

```typescript
import { createBrowserFromSession } from '../src/drivers/browser.js';

// Create browser from session
const { browser, context } = await createBrowserFromSession(session);

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
const browsers = await Promise.all(
  sessions.map(session => createBrowserFromSession(session))
);
const page = await browsers[0].context.newPage(); // Now it works!
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

1. Filters out completed targets (`done === true`)
2. Respects blocked proxies from site configs
3. Matches URLs to compatible sessions
4. Returns at most N pairs where N = number of sessions
5. Each session is used at most once

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

## Summary

- **SessionManager** = Manages the pool of browser sessions
- **SiteManager** = Provides site configs, proxies, and tracks progress
- **Distributor** = Intelligently assigns work to available resources

Let these three components work together as designed, and avoid the temptation to manually manage session creation or work distribution!