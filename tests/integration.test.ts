import { test, expect } from 'bun:test';
import { createBrowser } from '../src/lib/browser.js';
import { loadProxies, getProxyById, formatProxyForPlaywright } from '../src/lib/proxy.js';
import { RequestCache } from '../src/lib/cache.js';

test('Integration - browser + proxy + cache', async () => {
  // Skip if no API key (CI environment)
  if (!process.env.BROWSERBASE_API_KEY) {
    console.log('Skipping Browserbase integration test - no API key');
    return;
  }

  // 1. Load proxy
  const proxyStore = await loadProxies();
  const proxy = getProxyById(proxyStore, 'oxylabs-us-datacenter-1');
  expect(proxy).toBeDefined();
  if (!proxy) return;

  // 2. Create local browser (since we don't have a real Browserbase session)
  const { browser, cleanup } = await createBrowser({
    provider: 'local'
  });

  try {
    // 3. Create context with proxy
    const context = await browser.newContext({
      proxy: formatProxyForPlaywright(proxy)
    });
    const page = await context.newPage();

    // 4. Enable caching
    const cache = new RequestCache({ 
      maxSizeBytes: 100 * 1024 * 1024 // 100MB
    });
    await cache.enableForPage(page);

    // 5. Navigate to test site
    await page.goto('https://httpbin.org/ip');
    const response1 = await page.textContent('body');
    expect(response1).toContain('origin');

    // Check cache miss
    let stats = cache.getStats();
    expect(stats.misses).toBeGreaterThan(0);
    expect(stats.hits).toBe(0);

    // 6. Navigate again to test cache hit
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

test('Integration - local browser without proxy', async () => {
  // Simple integration test without proxy
  const { browser, cleanup } = await createBrowser({
    provider: 'local'
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Enable caching
    const cache = new RequestCache({ 
      maxSizeBytes: 50 * 1024 * 1024 // 50MB
    });
    await cache.enableForPage(page);

    // Make multiple requests
    await page.goto('https://example.com');
    const title1 = await page.title();
    
    // Second request should hit cache
    await page.goto('https://example.com');
    const title2 = await page.title();
    
    expect(title1).toBe(title2);
    
    const stats = cache.getStats();
    expect(stats.hits).toBeGreaterThan(0);
    expect(stats.itemCount).toBeGreaterThan(0);

    await context.close();
  } finally {
    await cleanup();
  }
});