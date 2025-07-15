import { test, expect } from 'vitest';
import { createLocalSession, createBrowserbaseSession, createBrowserFromSession } from '../src/drivers/browser.js';
import { loadProxies, getProxyById, getDefaultProxy } from '../src/drivers/proxy.js';
import { RequestCache } from '../src/drivers/cache.js';

test('Integration - local browser + proxy + cache', async () => {
  // Load proxy
  const proxyStore = await loadProxies();
  const proxy = getProxyById(proxyStore, 'oxylabs-us-datacenter-1');
  expect(proxy).toBeDefined();
  if (!proxy) return;

  // Create session with proxy
  const session = await createLocalSession({ proxy, headless: true });
  const { browser, createContext, cleanup } = await createBrowserFromSession(session);

  try {
    // Create context (proxy automatically applied)
    const context = await createContext();
    const page = await context.newPage();

    // Enable caching
    const cache = new RequestCache({ 
      maxSizeBytes: 100 * 1024 * 1024 // 100MB
    });
    await cache.enableForPage(page);

    // Navigate to test site
    await page.goto('https://httpbin.org/ip');
    const response1 = await page.textContent('body');
    expect(response1).toContain('origin');

    // Check cache miss
    let stats = cache.getStats();
    expect(stats.misses).toBeGreaterThan(0);
    expect(stats.hits).toBe(0);

    // Navigate again to test cache hit
    await page.goto('https://httpbin.org/ip');
    const response2 = await page.textContent('body');
    
    // Responses should be identical (from cache)
    expect(response2).toBe(response1);

    // Check cache hit
    stats = cache.getStats();
    expect(stats.hits).toBeGreaterThan(0);
    
    console.log('Cache stats:', stats);

    await context.close();
  } finally {
    await cleanup();
  }
});

test('Integration - session without proxy', async () => {
  // Create session without proxy
  const session = await createLocalSession({ headless: true });
  const { browser, createContext, cleanup } = await createBrowserFromSession(session, {
    blockImages: true
  });

  try {
    const context = await createContext();
    const page = await context.newPage();

    // Enable caching
    const cache = new RequestCache({ 
      maxSizeBytes: 50 * 1024 * 1024 // 50MB
    });
    await cache.enableForPage(page);

    // Make multiple requests
    await page.goto('https://httpbin.org/user-agent');
    const response1 = await page.textContent('body');
    
    // Second request should hit cache
    await page.goto('https://httpbin.org/user-agent');
    const response2 = await page.textContent('body');
    
    // Responses should be identical (from cache)
    expect(response2).toBe(response1);
    
    const stats = cache.getStats();
    expect(stats.hits).toBeGreaterThan(0);
    expect(stats.itemCount).toBeGreaterThan(0);

    await context.close();
  } finally {
    await cleanup();
  }
});

test('Integration - Browserbase session (mock)', async () => {
  // Skip if no API key
  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
    console.log('Skipping Browserbase integration test - no credentials');
    return;
  }

  // Mock fetch to avoid actual API calls in tests
  const originalFetch = global.fetch;
  global.fetch = async (url: any, options: any) => {
    if (url.includes('api.browserbase.com')) {
      return {
        ok: true,
        json: async () => ({
          id: 'test-session-id',
          connectUrl: 'wss://fake-connect-url',
          projectId: 'test-project'
        })
      } as any;
    }
    return originalFetch(url, options);
  };

  try {
    // Load default proxy
    const proxyStore = await loadProxies();
    const proxy = getDefaultProxy(proxyStore);

    // Create Browserbase session
    const session = await createBrowserbaseSession({ proxy });
    
    expect(session.provider).toBe('browserbase');
    expect(session.browserbase).toBeDefined();
    expect(session.browserbase?.id).toBe('test-session-id');
    
    // Note: Can't actually connect in tests without real session
    // Just verify session structure
    
    await session.cleanup();
  } finally {
    global.fetch = originalFetch;
  }
});