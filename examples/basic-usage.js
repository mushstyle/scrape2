#!/usr/bin/env node --env-file=.env

/**
 * Basic usage example of browser, proxy, and cache modules
 * 
 * Demonstrates:
 * - Loading proxy configuration
 * - Creating a browser with image blocking
 * - Enabling cache on a page
 * - Making cached requests
 * 
 * Run with: npm run example
 */

import { createBrowser } from '../src/lib/browser.ts';
import { loadProxies, getProxyById, formatProxyForPlaywright } from '../src/lib/proxy.ts';
import { RequestCache } from '../src/lib/cache.ts';

async function main() {
  console.log('📦 Loading proxies...');
  const proxyStore = await loadProxies();
  const proxy = getProxyById(proxyStore, 'oxylabs-us-1');
  console.log(`✅ Using proxy: ${proxy?.id}`);
  if (proxy) {
    console.log(`   URL: ${proxy.url}`);
    console.log(`   Type: ${proxy.type}`);
    console.log(`   Username: ${proxy.username}`);
  }

  console.log('\n🌐 Creating local browser...');
  const { browser, cleanup } = await createBrowser({
    provider: 'local'
  });

  try {
    // Create context with proxy if available
    const contextOptions = proxy ? {
      proxy: formatProxyForPlaywright(proxy)
    } : {};
    
    if (proxy) {
      console.log('Proxy config:', JSON.stringify(contextOptions.proxy, null, 2));
    }
    
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    console.log('\n💾 Enabling cache...');
    const cache = new RequestCache({
      maxSizeBytes: 100 * 1024 * 1024, // 100MB
      ttlSeconds: 300 // 5 minutes
    });
    await cache.enableForPage(page);

    console.log('\n🔍 Navigating to test page...');
    try {
      const response = await page.goto('https://httpbin.org/headers');
      console.log(`First request completed - Status: ${response?.status()}`);
    } catch (e) {
      console.log('Navigation error:', e);
    }

    // Check cache stats
    let stats = cache.getStats();
    console.log(`Cache stats: ${stats.hits} hits, ${stats.misses} misses, ${stats.itemCount} items`);

    // Make same request again
    console.log('\n🔄 Making same request again...');
    await page.goto('https://httpbin.org/headers');
    
    stats = cache.getStats();
    console.log(`Cache stats: ${stats.hits} hits, ${stats.misses} misses, ${stats.itemCount} items`);

    // Get page content
    const content = await page.textContent('body');
    console.log('\n📄 Response preview:', content?.substring(0, 200) + '...');

    await context.close();
  } finally {
    console.log('\n🧹 Cleaning up...');
    await cleanup();
    console.log('✅ Done!');
  }
}

// Run the example
main().catch(console.error);