#!/usr/bin/env bun

/**
 * Cache performance demonstration
 * 
 * Shows real-world cache performance by:
 * - Loading a product page (all resources downloaded)
 * - Reloading same page (cache hits)
 * - Loading different product (shared resources from cache)
 * 
 * Demonstrates typical 40-90% bandwidth savings and performance improvements
 * 
 * Run with: bun run examples/cache-performance.ts
 */

import { createBrowser } from '../src/lib/browser.js';
import { loadProxies, getProxyById, formatProxyForPlaywright } from '../src/lib/proxy.js';
import { RequestCache } from '../src/lib/cache.js';

async function main() {
  console.log('📦 Loading proxies...');
  const proxyStore = await loadProxies();
  const proxy = getProxyById(proxyStore, 'oxylabs-us-1');
  console.log(`✅ Using proxy: ${proxy?.id}`);

  console.log('\n🌐 Creating local browser...');
  const { browser, cleanup } = await createBrowser({
    provider: 'local'
  });

  try {
    const contextOptions = proxy ? {
      proxy: formatProxyForPlaywright(proxy)
    } : {};
    
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    console.log('\n💾 Enabling cache...');
    const cache = new RequestCache({
      maxSizeBytes: 100 * 1024 * 1024, // 100MB
      ttlSeconds: 300 // 5 minutes
    });
    await cache.enableForPage(page);

    console.log('\n🔍 First navigation to iam-store.com...');
    const start1 = Date.now();
    await page.goto('https://iam-store.com/collections/knitwear/products/braided-brown-sweater', {
      waitUntil: 'domcontentloaded'
    });
    const time1 = Date.now() - start1;
    
    let stats = cache.getStats();
    console.log(`✅ First load completed in ${time1}ms`);
    console.log(`📊 Cache stats: ${stats.hits} hits, ${stats.misses} misses, ${stats.itemCount} items, ${(stats.sizeBytes / 1024 / 1024).toFixed(2)} MB`);

    console.log('\n🔄 Second navigation (same page, should hit cache)...');
    const start2 = Date.now();
    await page.goto('https://iam-store.com/collections/knitwear/products/braided-brown-sweater', {
      waitUntil: 'domcontentloaded'
    });
    const time2 = Date.now() - start2;
    
    stats = cache.getStats();
    console.log(`✅ Second load completed in ${time2}ms (${((1 - time2/time1) * 100).toFixed(1)}% faster)`);
    console.log(`📊 Cache stats: ${stats.hits} hits, ${stats.misses} misses, ${stats.itemCount} items`);
    console.log(`💾 Cache hit rate: ${((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1)}%`);

    console.log('\n🔍 Third navigation to different product...');
    const start3 = Date.now();
    await page.goto('https://iam-store.com/collections/shop-all/products/blueberry-crop-sweater', {
      waitUntil: 'domcontentloaded'
    });
    const time3 = Date.now() - start3;
    
    stats = cache.getStats();
    console.log(`✅ Third load completed in ${time3}ms`);
    console.log(`📊 Final cache stats: ${stats.hits} hits, ${stats.misses} misses, ${stats.itemCount} items`);
    console.log(`💾 Cache hit rate: ${((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1)}%`);
    console.log(`📦 Total cache size: ${(stats.sizeBytes / 1024 / 1024).toFixed(2)} MB`);

    await context.close();
  } finally {
    console.log('\n🧹 Cleaning up...');
    await cleanup();
    console.log('✅ Done!');
  }
}

main().catch(console.error);