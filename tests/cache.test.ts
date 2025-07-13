import { test, expect } from 'bun:test';
import { chromium } from 'playwright';
import { RequestCache } from '../src/lib/cache.js';

test('RequestCache - basic caching', async () => {
  const cache = new RequestCache({
    maxSizeBytes: 10 * 1024 * 1024 // 10MB
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // Enable caching for the page
  await cache.enableForPage(page);

  // First request - should be a miss
  await page.goto('https://httpbin.org/json');
  let stats = cache.getStats();
  expect(stats.misses).toBe(1);
  expect(stats.hits).toBe(0);

  // Second request to same URL - should be a hit
  await page.goto('https://httpbin.org/json');
  stats = cache.getStats();
  expect(stats.misses).toBe(1);
  expect(stats.hits).toBe(1);

  await browser.close();
});

test('RequestCache - respects size limit', async () => {
  // Very small cache
  const cache = new RequestCache({
    maxSizeBytes: 1024 // 1KB
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await cache.enableForPage(page);

  // Make multiple requests that exceed cache size
  await page.goto('https://httpbin.org/json');
  await page.goto('https://httpbin.org/uuid');
  await page.goto('https://httpbin.org/user-agent');

  const stats = cache.getStats();
  // Size should not exceed limit
  expect(stats.sizeBytes).toBeLessThanOrEqual(1024);

  await browser.close();
});

test('RequestCache - clear by domain', async () => {
  const cache = new RequestCache({
    maxSizeBytes: 10 * 1024 * 1024
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await cache.enableForPage(page);

  // Cache some requests
  await page.goto('https://httpbin.org/json');
  await page.goto('https://example.com');

  let stats = cache.getStats();
  expect(stats.itemCount).toBe(2);

  // Clear only httpbin.org
  cache.clear('httpbin.org');

  // example.com should still be cached
  await page.goto('https://example.com');
  stats = cache.getStats();
  expect(stats.hits).toBe(1);

  await browser.close();
});

test('RequestCache - TTL expiration', async () => {
  const cache = new RequestCache({
    maxSizeBytes: 10 * 1024 * 1024,
    ttlSeconds: 0.1 // 100ms TTL for testing
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await cache.enableForPage(page);

  // First request
  await page.goto('https://httpbin.org/json');
  
  // Immediate second request - should hit cache
  await page.goto('https://httpbin.org/json');
  let stats = cache.getStats();
  expect(stats.hits).toBe(1);

  // Wait for TTL to expire
  await new Promise(resolve => setTimeout(resolve, 150));

  // Third request - should miss cache due to TTL
  await page.goto('https://httpbin.org/json');
  stats = cache.getStats();
  expect(stats.misses).toBe(2);
  expect(stats.hits).toBe(1);

  await browser.close();
});