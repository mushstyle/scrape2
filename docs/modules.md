# Browser, Proxy, and Cache Modules

Clean, modular building blocks for web scraping with Playwright.

## Overview

This project provides three core modules that work together or independently:
- **Browser Module**: Creates Playwright browsers (Browserbase or local)
- **Proxy Module**: Manages proxy configurations
- **Cache Module**: In-memory request/response caching with automatic Bun compatibility

## Browser Module (`src/lib/browser.ts`)

Creates Playwright browser instances from either Browserbase or local Chrome.

### Usage

```typescript
import { createBrowser } from './lib/browser.js';

// Local browser (always headed)
const { browser, cleanup } = await createBrowser({
  provider: 'local',
  blockImages: true  // Optional, defaults to true
});

// Browserbase (requires BROWSERBASE_API_KEY in .env)
const { browser, cleanup } = await createBrowser({
  provider: 'browserbase',
  sessionId: 'your-session-id',
  blockImages: false  // Optional
});

// Always cleanup when done
await cleanup();
```

### Features
- Returns both browser instance and cleanup function
- Local browsers are always headed (never headless)
- Browserbase requires API key from environment
- Image blocking enabled by default (saves bandwidth)
- Image blocking is applied to all contexts created from the browser

## Proxy Module (`src/lib/proxy.ts`)

Loads and manages proxy configurations from `db/proxies.json`.

### Usage

```typescript
import { loadProxies, getProxyById, formatProxyForPlaywright } from './lib/proxy.js';

// Load proxy configuration
const store = await loadProxies();

// Get specific proxy
const proxy = getProxyById(store, 'oxylabs-us-datacenter-1');

// Format for Playwright
const formatted = formatProxyForPlaywright(proxy);

// Use with Playwright
const context = await browser.newContext({ proxy: formatted });
```

### Features
- Loads proxy configuration from JSON
- Provides helper functions for proxy selection
- Formats proxy for Playwright compatibility
- Caches configuration for performance

## Cache Module (`src/lib/cache.ts`)

In-memory request caching with automatic LRU eviction and Bun compatibility.

### Usage

```typescript
import { RequestCache } from './lib/cache.js';

const cache = new RequestCache({
  maxSizeBytes: 100 * 1024 * 1024, // 100MB
  ttlSeconds: 300 // Optional TTL
});

// Enable for a page
await cache.enableForPage(page);

// Get statistics
const stats = cache.getStats();
console.log(`Hit rate: ${((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1)}%`);

// Clear cache
cache.clear(); // Clear all
cache.clear('example.com'); // Clear specific domain
```

### Features
- Automatic Bun compatibility (works around Playwright limitations)
- LRU eviction when size limit exceeded
- Optional TTL support
- Domain-based cache clearing
- Detailed statistics

## Design Principles

1. **Single Responsibility**: Each module does ONE thing well
2. **No Error Handling**: Errors propagate naturally to caller
3. **Simple Interfaces**: Minimal API surface, obvious usage
4. **Zero Dependencies**: Only Playwright and Node.js built-ins
5. **Composability**: Modules work independently or together

## Integration Example

```typescript
import { createBrowser } from './lib/browser.js';
import { loadProxies, getProxyById, formatProxyForPlaywright } from './lib/proxy.js';
import { RequestCache } from './lib/cache.js';

// 1. Load proxy
const proxyStore = await loadProxies();
const proxy = getProxyById(proxyStore, 'oxylabs-us-1');

// 2. Create browser with image blocking
const { browser, cleanup } = await createBrowser({
  provider: 'local',
  blockImages: true
});

// 3. Create context with proxy
const context = await browser.newContext({
  proxy: proxy ? formatProxyForPlaywright(proxy) : undefined
});
const page = await context.newPage();

// 4. Enable caching
const cache = new RequestCache({ maxSizeBytes: 100 * 1024 * 1024 });
await cache.enableForPage(page);

// 5. Use normally
await page.goto('https://example.com');

// 6. Cleanup
await cleanup();
```

## Testing

```bash
# Run all tests
bun test

# Run specific module tests
bun test tests/browser.test.ts
bun test tests/proxy.test.ts
bun test tests/cache.test.ts
bun test tests/integration.test.ts
```