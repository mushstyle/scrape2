# Architecture Overview

## Core Concepts

The scraping infrastructure is built around three main concepts:

1. **Sessions** - Browser sessions that can be either local or remote (Browserbase)
2. **Providers** - External services that provide browser instances
3. **Contexts** - Browser contexts with automatic proxy and configuration handling

## Directory Structure

```
src/
├── providers/          # External browser providers
│   ├── browserbase.ts  # Browserbase session creation
│   └── local-browser.ts # Local Chrome session creation
├── lib/               # Core functionality
│   ├── browser.ts     # Browser/context creation from sessions
│   ├── proxy.ts       # Proxy loading and formatting
│   └── cache.ts       # Request caching layer
└── types/             # TypeScript interfaces
    ├── session.ts     # Session interfaces
    ├── proxy.ts       # Proxy interfaces
    └── browser.ts     # Browser interfaces
```

## Session-Based Architecture

### CRITICAL: Browser Creation Flow

**The ONLY correct flow is: Provider → Session → Browser (via browser.ts)**

1. **Providers** create sessions
2. **Sessions** contain browser connection info
3. **browser.ts** creates browsers from sessions

**NEVER:**
- Create browsers directly with Playwright
- Call chromium.launch() or chromium.connect()
- Bypass browser.ts

### 1. Create a Session

Sessions are created through provider-specific functions that share a common interface:

```typescript
import { createSession } from '../src/providers/browserbase.js';
// or
import { createSession } from '../src/providers/local-browser.js';

const session = await createSession({
  proxy: proxyObject  // Optional proxy configuration
});
```

**Key Points:**
- Both providers accept the same `SessionOptions` interface
- Proxy configuration is handled differently:
  - **Browserbase**: Proxy is configured at session creation via API
  - **Local**: Proxy is stored and applied when creating contexts
- Sessions DO NOT create browsers - they only prepare the connection

### 2. Create Browser from Session (MANDATORY)

Once you have a session, create a browser instance:

```typescript
import { createBrowserFromSession } from '../src/lib/browser.js';

const { browser, createContext, cleanup } = await createBrowserFromSession(session, {
  blockImages: true  // Optional, defaults to true
});
```

**Returns:**
- `browser`: The Playwright Browser instance
- `createContext()`: Helper function that creates contexts with automatic proxy application
- `cleanup()`: Cleanup function that closes browser and releases session

### 3. Create Contexts

Use the `createContext()` helper to create browser contexts:

```typescript
const context = await createContext({
  // Any Playwright context options
});

// For local browsers, proxy is automatically applied if provided in session
// For Browserbase, the session is already proxied
```

## Provider Details

### Browserbase Provider

```typescript
// src/providers/browserbase.ts
export async function createSession(options: SessionOptions): Promise<Session>
```

- Requires `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` env vars
- Creates session via API with optional proxy configuration
- Returns session with `connectUrl` for CDP connection
- Cleanup releases the session via API

### Local Browser Provider

```typescript
// src/providers/local-browser.ts
export async function createSession(options: SessionOptions): Promise<Session>
```

- Launches local Chrome browser (always headed)
- Stores proxy configuration for later use
- Proxy is applied when creating contexts
- Cleanup closes the browser process

## Proxy Handling

The proxy system is designed to be transparent:

1. **Load proxies** from `db/proxies.json`:
   ```typescript
   const proxyStore = await loadProxies();
   const proxy = getDefaultProxy(proxyStore);
   ```

2. **Pass to session creation**:
   ```typescript
   const session = await createSession({ proxy });
   ```

3. **Automatic application**:
   - Browserbase: Proxy configured at session level
   - Local: Proxy applied via `formatProxyForPlaywright()` when creating contexts

## Request Caching

The caching layer is **opt-in** and must be explicitly enabled for each page:

### When to Enable Cache

1. **Create page first**:
   ```typescript
   const context = await createContext();
   const page = await context.newPage();
   ```

2. **Enable caching**:
   ```typescript
   const cache = new RequestCache({ 
     maxSizeBytes: 100 * 1024 * 1024, // 100MB
     ttlSeconds: 300 // 5 minutes
   });
   await cache.enableForPage(page);
   ```

3. **Navigate** - requests will now be cached:
   ```typescript
   await page.goto('https://example.com');
   ```

### How Caching Works

- **Interception**: Uses Playwright's `page.route('**/*')` to intercept all requests
- **GET only**: Only caches GET requests
- **No auth**: Skips requests with authorization/cookie headers
- **In-memory**: Cache is not persisted between runs
- **Per-page**: Each page needs its own cache enablement

### Cache Stats

```typescript
const stats = cache.getStats();
// { hits: 5, misses: 10, sizeBytes: 1048576, itemCount: 15 }
```

## Complete Example

See `examples/session-based-usage.js` for a working example. Run it with:

```bash
npm run example
```

The example demonstrates:
- Creating sessions for both local and Browserbase providers
- Automatic proxy configuration
- Image blocking
- Proper cleanup

Key code pattern:

```typescript
import { createSession as createBrowserbaseSession } from './providers/browserbase.js';
import { createBrowserFromSession } from './lib/browser.js';
import { loadProxies, getDefaultProxy } from './lib/proxy.js';

// 1. Load proxy
const proxyStore = await loadProxies();
const proxy = getDefaultProxy(proxyStore);

// 2. Create session with proxy
const session = await createBrowserbaseSession({ proxy });

// 3. Create browser from session
const { browser, createContext, cleanup } = await createBrowserFromSession(session, {
  blockImages: true
});

try {
  // 4. Create context (proxy automatically applied)
  const context = await createContext();
  const page = await context.newPage();
  
  // 5. Navigate and scrape
  await page.goto('https://httpbin.org/ip');
  const ipInfo = await page.textContent('body');
  
} finally {
  // 7. Cleanup
  await cleanup();
}
```

## Benefits

1. **Unified Interface**: Same API for local and remote browsers
2. **Transparent Proxy Handling**: Proxies work the same way regardless of provider
3. **Clean Separation**: External providers isolated in their own modules
4. **Resource Management**: Explicit cleanup functions prevent leaks
5. **Type Safety**: Full TypeScript support throughout

## Scraping Orchestration System

The orchestration system builds on top of the session architecture to manage large-scale scraping operations.

### Core Components

1. **ETL API Provider** (`src/providers/etl-api.ts`)
   - Manages scrape runs and their lifecycle
   - Handles item status updates
   - Provides run statistics and metadata

2. **Distributor** (`src/lib/distributor.ts`)
   - Pure functional core for distributing items to sessions
   - Simple linear matching algorithm with 1:1 mapping
   - Each session can only be used once per distribution
   - Matches sessions based on proxy requirements from SiteConfig
   - Returns max N URL-session pairs where N = number of sessions
   - Filters out completed items automatically

3. **Session Manager** (`src/lib/session-manager.ts`)
   - Manages pool of browser sessions
   - **MUST store actual Session objects, not just IDs**
   - Returns Session objects that can be used with browser.ts
   - Handles session creation, destruction, and health checks
   - Tracks session usage and statistics
   - **Critical**: getActiveSessions() must return Session[] not string[]

4. **Site Manager** (`src/lib/site-manager.ts`)
   - Loads and manages site configurations
   - Maintains in-memory state for sites
   - Provides filtered access (sites with start pages, etc.)
   - Handles sessionLimit logic for each site
   - Supports custom data storage per site
   - Tracks site scraping history and statistics

5. **Scrape Run Manager** (`src/lib/scrape-run-manager.ts`)
   - High-level API for managing scrape runs
   - Handles run creation, item updates, and finalization
   - Provides run statistics and progress tracking

## CRITICAL: Session and Browser Management

**The architecture requires this exact flow:**

1. **Providers create Sessions** - Session objects contain connection info
2. **SessionManager stores Session objects** - NOT just IDs or metadata
3. **Distributor works with Sessions** - Maps URLs to actual Session objects
4. **browser.ts creates browsers** - Uses Session objects to create browsers

**Common mistakes to avoid:**
- ❌ Storing only session IDs in SessionManager
- ❌ Creating browsers directly without browser.ts
- ❌ Returning string[] instead of Session[] from getActiveSessions()
- ❌ Creating sessions without storing the Session object

### Orchestration Flow

1. **Create/Resume Run**: Get or create a scrape run for a domain
2. **Get Pending Items**: Fetch items that haven't been processed
3. **Create Sessions**: Spin up browser sessions based on concurrency needs
4. **Distribute Items**: Use distributor to assign items to sessions
5. **Process Items**: Scrape items and update their status
6. **Track Progress**: Monitor completion and handle failures
7. **Finalize Run**: Mark run as complete when all items are processed

### Example Usage

```typescript
import { SessionManager } from '../src/lib/session-manager.js';
import { SiteManager } from '../src/lib/site-manager.js';
import { ScrapeRunManager } from '../src/lib/scrape-run-manager.js';
import { itemsToSessions } from '../src/lib/distributor.js';
import { createBrowserFromSession } from '../src/lib/browser.js';

// Initialize managers
const sessionManager = new SessionManager({ sessionLimit: 5 });
const runManager = new ScrapeRunManager();
const siteManager = new SiteManager();

// Load sites
await siteManager.loadSites();

// Get or create run
const run = await runManager.getOrCreateRun('example.com');
const pendingItems = await runManager.getPendingItems(run.id);

// Create sessions (returns actual Session objects)
const sessions = [];
for (let i = 0; i < 3; i++) {
  const session = await sessionManager.createSession();
  sessions.push(session);
}

// Convert Sessions to SessionInfo for distributor
const sessionInfos = sessions.map(session => ({
  id: session.provider === 'browserbase' ? session.browserbase.id : 'local-id',
  proxyType: 'datacenter',
  proxyGeo: 'US'
}));

// Get site configs
const siteConfigs = siteManager.getSiteConfigs();

// Distribute items
const urlSessionPairs = itemsToSessions(pendingItems, sessionInfos, siteConfigs);

// Process items (simplified)
for (const { url, sessionId } of urlSessionPairs) {
  // Find the actual Session object
  const session = sessions.find(s => 
    s.provider === 'browserbase' ? s.browserbase.id === sessionId : false
  );
  
  if (!session) continue;
  
  // Create browser from session (THIS IS THE ONLY WAY!)
  const { browser, createContext } = await createBrowserFromSession(session);
  const context = await createContext();
  const page = await context.newPage();
  
  // Scrape the URL...
  await page.goto(url);
  
  // Cleanup
  await context.close();
  
  // Update status
  await runManager.updateItemStatus(run.id, url, { done: true });
}

// Finalize when complete
await runManager.finalizeRun(run.id);
```

See `examples/orchestration-demo.ts` for a complete working example.