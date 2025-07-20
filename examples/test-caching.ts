/**
 * Test script to verify request caching functionality
 */

import { SessionManager } from '../src/services/session-manager.js';
import { createBrowserFromSession } from '../src/drivers/browser.js';
import { RequestCache } from '../src/drivers/cache.js';
import { logger } from '../src/utils/logger.js';

const log = logger.createContext('test-caching');

async function main() {
  const sessionManager = new SessionManager();
  
  // Create a local session for testing
  const session = await sessionManager.createSession({
    domain: 'example.com',
    browserType: 'local'
  });
  
  log.normal('Created session');
  
  // Create browser and cache
  const { browser, createContext } = await createBrowserFromSession(session);
  const context = await createContext();
  
  // Create cache
  const cache = new RequestCache({
    maxSizeBytes: 10 * 1024 * 1024, // 10MB
    ttlSeconds: 300 // 5 minutes
  });
  
  // Test with multiple pages hitting same resources
  log.normal('\n=== First page load (cold cache) ===');
  const page1 = await context.newPage();
  await cache.enableForPage(page1);
  await page1.goto('https://amgbrand.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  
  let stats = cache.getStats();
  log.normal(`After page 1: ${stats.hits} hits, ${stats.misses} misses, ${(stats.sizeBytes / 1024).toFixed(1)}KB cached`);
  
  // Second page should hit cache for shared resources
  log.normal('\n=== Second page load (warm cache) ===');
  const page2 = await context.newPage();
  await cache.enableForPage(page2);
  await page2.goto('https://amgbrand.com/collections/all', { waitUntil: 'domcontentloaded', timeout: 30000 });
  
  stats = cache.getStats();
  log.normal(`After page 2: ${stats.hits} hits, ${stats.misses} misses, ${(stats.sizeBytes / 1024).toFixed(1)}KB cached`);
  
  // Third page to same URL should have high cache hits
  log.normal('\n=== Third page load (same URL) ===');
  const page3 = await context.newPage();
  await cache.enableForPage(page3);
  await page3.goto('https://amgbrand.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  
  stats = cache.getStats();
  const hitRate = stats.hits + stats.misses > 0 
    ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1)
    : '0.0';
  log.normal(`After page 3: ${stats.hits} hits, ${stats.misses} misses (${hitRate}% hit rate), ${(stats.sizeBytes / 1024).toFixed(1)}KB cached`);
  
  // Clean up
  await page1.close();
  await page2.close();
  await page3.close();
  await context.close();
  await browser.close();
  await session.cleanup();
  
  log.normal('\n=== Summary ===');
  log.normal(`Cache effectiveness: ${hitRate}% hit rate`);
  log.normal(`Total requests: ${stats.hits + stats.misses}`);
  log.normal(`Cached data: ${(stats.sizeBytes / 1024).toFixed(1)}KB`);
}

main().catch(error => {
  log.error('Test failed:', error);
  process.exit(1);
});