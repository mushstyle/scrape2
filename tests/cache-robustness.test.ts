import { describe, it, expect, beforeEach } from 'vitest';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { RequestCache } from '../src/drivers/cache.js';

describe('RequestCache robustness', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cache: RequestCache;
  
  beforeEach(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
    
    cache = new RequestCache({
      maxSizeBytes: 10 * 1024 * 1024, // 10MB
      ttlSeconds: 300
    });
  });
  
  it('should handle page closing gracefully without crashing', async () => {
    // Enable caching
    await cache.enableForPage(page);
    
    // Start loading a page
    const loadPromise = page.goto('https://example.com').catch(() => {});
    
    // Close the page immediately
    await page.close();
    
    // Wait for any pending operations
    await loadPromise;
    
    // Should not throw
    expect(true).toBe(true);
  });
  
  it('should handle context closing gracefully', async () => {
    // Enable caching
    await cache.enableForPage(page);
    
    // Start loading a page
    const loadPromise = page.goto('https://example.com').catch(() => {});
    
    // Close the context immediately
    await context.close();
    
    // Wait for any pending operations
    await loadPromise;
    
    // Should not throw
    expect(true).toBe(true);
  });
  
  it('should handle browser closing gracefully', async () => {
    // Enable caching
    await cache.enableForPage(page);
    
    // Start loading a page
    const loadPromise = page.goto('https://example.com').catch(() => {});
    
    // Close the browser immediately
    await browser.close();
    
    // Wait for any pending operations
    await loadPromise;
    
    // Should not throw
    expect(true).toBe(true);
  });
  
  afterEach(async () => {
    try {
      await page?.close();
    } catch {}
    try {
      await context?.close();
    } catch {}
    try {
      await browser?.close();
    } catch {}
  });
});