# Browser, Proxy, and Cache Interfaces Plan

**Goal:** Create INSANELY clean, robust, and simple interfaces for managing browsers, proxies, and caching with single-responsibility modules and clear contracts.

## Implementation Steps

[ ] 1. Create Browser Module (`src/lib/browser.ts`)
   - [ ] Define TypeScript interfaces for BrowserOptions and BrowserResult
   - [ ] Implement createBrowser function for Browserbase connection
   - [ ] Implement createBrowser function for local Chrome (always headed)
   - [ ] Add cleanup function that properly closes browser instances
   - [ ] Create type definitions in `src/lib/types/browser.ts`

[ ] 2. Create Proxy Module (`src/lib/proxy.ts`)
   - [ ] Define TypeScript interfaces for Proxy and ProxyStore
   - [ ] Implement loadProxies function to read from db/proxies.json
   - [ ] Implement getProxyById function for specific proxy retrieval
   - [ ] Implement getDefaultProxy function
   - [ ] Implement formatProxyForPlaywright converter function
   - [ ] Create type definitions in `src/lib/types/proxy.ts`

[ ] 3. Create Cache Module (`src/lib/cache.ts`)
   - [ ] Define CacheOptions interface with maxSizeBytes (default 100MB)
   - [ ] Implement RequestCache class constructor
   - [ ] Implement enableForPage method with Playwright route interception
   - [ ] Implement LRU eviction when size limit exceeded
   - [ ] Implement getStats method for cache metrics
   - [ ] Implement clear method with optional domain filtering
   - [ ] Create type definitions in `src/lib/types/cache.ts`

[ ] 4. Create Integration Tests
   - [ ] Test browser creation with Browserbase
   - [ ] Test browser creation with local Chrome
   - [ ] Test proxy loading and selection
   - [ ] Test cache functionality with real Playwright pages
   - [ ] Create example usage scripts

[ ] 5. Documentation
   - [ ] Add JSDoc comments to all public interfaces
   - [ ] Create usage examples in comments
   - [ ] Document any Playwright version requirements

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

**Key Considerations:**
- [ ] Browser module must handle Browserbase WebSocket URL construction correctly
- [ ] Local browsers must ALWAYS be headed (headless: false)
- [ ] Cache size limits must be enforced to prevent memory issues
- [ ] Proxy credentials must be handled securely (no logging)
- [ ] All async operations must have proper error propagation
- [ ] Module interfaces must be designed for future extension without breaking changes
- [ ] No external dependencies beyond Playwright and Node.js built-ins
- [ ] Type definitions must be comprehensive for full TypeScript support