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

### 2. Create Browser from Session

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