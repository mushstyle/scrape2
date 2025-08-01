import { test, expect } from 'vitest';
import { chromium } from 'playwright';
import { RequestCache } from '../src/drivers/cache.js';

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

  // Cache some requests from different paths
  await page.goto('https://httpbin.org/json');
  await page.goto('https://httpbin.org/uuid');

  let stats = cache.getStats();
  expect(stats.itemCount).toBe(2);

  // Clear httpbin.org domain
  cache.clear('httpbin.org');

  // Cache should be empty now
  stats = cache.getStats();
  expect(stats.itemCount).toBe(0);
  
  // Next request should be a miss
  await page.goto('https://httpbin.org/json');
  stats = cache.getStats();
  expect(stats.misses).toBe(3); // 2 initial + 1 after clear

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

test('RequestCache - image blocking', async () => {
  const cache = new RequestCache({
    maxSizeBytes: 10 * 1024 * 1024,
    blockImages: true
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // Track requests
  let imageRequests = 0;
  page.on('request', (request) => {
    if (request.resourceType() === 'image' || request.url().match(/\.(png|jpg|jpeg|gif|webp|svg|ico)(\?.*)?$/i)) {
      imageRequests++;
    }
  });
  
  await cache.enableForPage(page);

  // Use a simple HTML page with an image
  await page.setContent(`
    <html>
      <body>
        <img src="https://httpbin.org/image/png" />
        <img src="https://httpbin.org/image/jpeg" />
      </body>
    </html>
  `);
  
  // Wait a bit for image requests to be made
  await page.waitForTimeout(500);
  
  // Should have blocked images
  const stats = cache.getStats();
  expect(stats.blockedImages).toBe(imageRequests);
  expect(stats.blockedImages).toBeGreaterThan(0);

  await browser.close();
});

test('RequestCache - no image blocking when disabled', async () => {
  const cache = new RequestCache({
    maxSizeBytes: 10 * 1024 * 1024,
    blockImages: false
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await cache.enableForPage(page);

  // Use a simple HTML page with an image
  await page.setContent(`
    <html>
      <body>
        <img src="https://httpbin.org/image/png" />
      </body>
    </html>
  `);
  
  // Wait a bit for image request
  await page.waitForTimeout(500);
  
  // Should not have blocked any images
  const stats = cache.getStats();
  expect(stats.blockedImages).toBe(0);

  await browser.close();
});