# Browser, Proxy, and Cache Interfaces Plan

## Overview
Create INSANELY clean, robust, and simple interfaces for managing browsers, proxies, and caching. Focus on single-responsibility modules with clear contracts.

## Core Principles
1. **Single Responsibility** - Each module does ONE thing well
2. **Simple Interfaces** - Minimal API surface, obvious usage
3. **No Magic** - Explicit over implicit, predictable behavior
4. **Pure Functions** - Where possible, avoid side effects
5. **Type Safety** - Full TypeScript types for all interfaces

## Module Architecture

### 1. Browser Module (`src/lib/browser.ts`)

**Purpose**: Create Playwright browser instances from either Browserbase or local Chrome

**Interface**:
```typescript
interface BrowserOptions {
  provider: 'browserbase' | 'local';
  sessionId?: string; // Required for browserbase
  headless?: boolean; // Always false for local
}

interface BrowserResult {
  browser: Browser;
  cleanup: () => Promise<void>;
}

// Main function
async function createBrowser(options: BrowserOptions): Promise<BrowserResult>
```

**Key Design Decisions**:
- Returns both browser AND cleanup function (explicit resource management)
- Provider type is explicit enum, not string
- Browserbase requires sessionId, local ignores it
- Local browsers are ALWAYS headed (per requirements)

### 2. Proxy Module (`src/lib/proxy.ts`)

**Purpose**: Read and retrieve proxy information from proxies.json

**Interface**:
```typescript
interface Proxy {
  id: string;
  provider: string;
  type: 'residential' | 'datacenter';
  rotatingEndpoint?: boolean;
  geo: string;
  url: string;
  username: string;
  password: string;
}

interface ProxyStore {
  proxies: Proxy[];
  default: string;
}

// Load all proxies from JSON
async function loadProxies(): Promise<ProxyStore>

// Get specific proxy by ID
function getProxyById(store: ProxyStore, id: string): Proxy | null

// Get default proxy
function getDefaultProxy(store: ProxyStore): Proxy | null

// Convert proxy to Playwright format
function formatProxyForPlaywright(proxy: Proxy): { server: string; username: string; password: string }
```

**Key Design Decisions**:
- Separate loading from selection (composition over coupling)
- Return null for missing proxies (no exceptions)
- Include formatter for Playwright compatibility
- Immutable store pattern

### 3. Cache Module (`src/lib/cache.ts`)

**Purpose**: In-memory request/response caching for Playwright pages

**Interface**:
```typescript
interface CacheOptions {
  maxSizeBytes: number; // Default: 100MB
  ttlSeconds?: number; // Optional TTL
}

class RequestCache {
  constructor(options: CacheOptions);
  
  // Enable caching for a page
  async enableForPage(page: Page): Promise<void>;
  
  // Get cache statistics
  getStats(): {
    hits: number;
    misses: number;
    sizeBytes: number;
    itemCount: number;
  };
  
  // Clear cache (all or by domain)
  clear(domain?: string): void;
}
```

**Key Design Decisions**:
- Class-based for stateful cache management
- Simple size-based eviction (LRU)
- Automatic request interception via Playwright
- Domain-aware clearing
- Built-in statistics

## Integration Pattern

```typescript
// Example usage combining all modules
import { createBrowser } from './lib/browser.js';
import { loadProxies, getProxyById, formatProxyForPlaywright } from './lib/proxy.js';
import { RequestCache } from './lib/cache.js';

// 1. Load proxies
const proxyStore = await loadProxies();
const proxy = getProxyById(proxyStore, 'oxylabs-us-datacenter-1');

// 2. Create browser
const { browser, cleanup } = await createBrowser({
  provider: 'browserbase',
  sessionId: 'abc123'
});

// 3. Create page with proxy
const context = await browser.newContext({
  proxy: proxy ? formatProxyForPlaywright(proxy) : undefined
});
const page = await context.newPage();

// 4. Enable caching
const cache = new RequestCache({ maxSizeBytes: 100 * 1024 * 1024 });
await cache.enableForPage(page);

// 5. Use page normally...

// 6. Cleanup
await cleanup();
```

## File Structure

```
src/
  lib/
    browser.ts      # Browser creation interface
    proxy.ts        # Proxy loading and selection
    cache.ts        # Request caching
    types/
      browser.ts    # Browser-related types
      proxy.ts      # Proxy-related types
      cache.ts      # Cache-related types
```

## Implementation Notes

### Browser Module
- Use Playwright's `chromium.connectOverCDP()` for Browserbase
- Use `chromium.launch({ headless: false })` for local
- Include proper WebSocket URL construction for Browserbase
- Handle connection timeouts gracefully

### Proxy Module
- Use native fs.promises for JSON reading
- Validate proxy data structure on load
- Cache loaded data in module (singleton pattern)
- No external dependencies

### Cache Module
- Use Map for O(1) lookups
- Implement simple LRU with size tracking
- Intercept at request level, not response
- Skip caching for:
  - POST/PUT/DELETE requests
  - Requests with auth headers
  - Streaming responses

## Testing Strategy

Each module should have:
1. Unit tests for pure functions
2. Integration tests with real Playwright
3. Example scripts demonstrating usage

## Future Extensions (NOT in scope)

These are intentionally NOT included but designed to be added later:
- Browser pooling/reuse
- Proxy performance tracking
- Persistent caching
- Retry mechanisms
- Circuit breakers
- Monitoring/metrics export

## Success Criteria

1. **Simplicity**: Can a new developer understand each module in 5 minutes?
2. **Robustness**: Do the interfaces handle edge cases gracefully?
3. **Cleanliness**: Is the code self-documenting with minimal comments needed?
4. **Performance**: Is overhead negligible compared to raw Playwright?
5. **Composability**: Can modules be used independently or together?