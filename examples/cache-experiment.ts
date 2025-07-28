#!/usr/bin/env tsx --env-file=.env
/**
 * Cache Experiment Example
 * 
 * Simple benchmark that scrapes URLs once to measure cache effectiveness.
 * NO DATABASE WRITES. NO INFINITE LOOPS. JUST A SIMPLE BENCHMARK.
 * 
 * Usage:
 *   npm run example:cache-experiment                    # Run with caching (default)
 *   npm run example:cache-experiment -- --no-cache     # Run without caching
 *   npm run example:cache-experiment -- --local        # Use local browser (headless)
 *   npm run example:cache-experiment -- --local-headed # Use local browser (headed)
 */

import { createBrowserFromSession } from '../src/drivers/browser.js';
import { SessionManager } from '../src/services/session-manager.js';
import { getProxyById } from '../src/drivers/proxy.js';
import { RequestCache } from '../src/drivers/cache.js';
import { logger } from '../src/utils/logger.js';
import { writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import type { Browser } from 'playwright';

const log = logger.createContext('cache-experiment');

const TEST_URLS = [
  'https://www.cos.com/en-us/men/menswear/shirts/casualshirts/product/relaxed-twill-shirt-navy-1245704006',
  'https://www.cos.com/en-us/men/menswear/shirts/shortsleevedshirts/product/cotton-seersucker-resort-shirt-navy-1281649001',
  'https://www.cos.com/en-us/men/menswear/shirts/shortsleevedshirts/product/relaxed-short-sleeved-resort-shirt-blue-graphic-1282012002',
  'https://www.cos.com/en-us/men/menswear/shirts/shortsleevedshirts/product/camp-collar-linen-shirt-cobalt-1298721002',
  'https://www.cos.com/en-us/men/menswear/shirts/shortsleevedshirts/product/camp-collar-linen-shirt-white-blue-striped-1298721001',
  'https://www.cos.com/en-us/men/menswear/shirts/shortsleevedshirts/product/relaxed-flap-pocket-utility-shirt-apricot-1230855004',
  'https://www.cos.com/en-us/men/menswear/poloshirts/product/interlock-cotton-polo-shirt-white-1281644001',
  'https://www.cos.com/en-us/men/menswear/knitwear/knitted-polo-shirts/product/open-knit-boucl-polo-shirt-mole-mlange-1281652001',
  'https://www.cos.com/en-us/men/menswear/tshirts/slim-fit/product/slim-knitted-silk-t-shirt-grey-beige-1241762007',
  'https://www.cos.com/en-us/men/menswear/knitwear/cardigans/product/knit-panelled-cardigan-navy-1292174001'
];

const COST_PER_GB = 0.20;
const ESTIMATED_PAGE_SIZE_MB = 5; // Rough estimate for cos.com pages

interface ExperimentOptions {
  noCache: boolean;
  local: boolean;
  localHeaded: boolean;
}

interface CacheStats {
  hits: number;
  misses: number;
  requestsIntercepted: number;
  requestsSentToNetwork: number;
  bytesFromNetwork: number;
  bytesFromCache: number;
  requestDetails: Map<string, { fromCache: boolean; size: number }>;
}

function parseArgs(): ExperimentOptions {
  const args = process.argv.slice(2);
  return {
    noCache: args.includes('--no-cache'),
    local: args.includes('--local') || args.includes('--local-headed'),
    localHeaded: args.includes('--local-headed')
  };
}

function calculateCost(mbDownloaded: number): number {
  return (mbDownloaded / 1024) * COST_PER_GB;
}

async function runExperiment(options: ExperimentOptions): Promise<{ stats: CacheStats; duration: number; errors: string[] }> {
  // Create SessionManager with correct provider
  const provider = options.local ? 'local' : 'browserbase';
  const sessionManager = new SessionManager({ provider });
  let browser: Browser | null = null;
  const errors: string[] = [];
  const stats: CacheStats = { 
    hits: 0, 
    misses: 0, 
    requestsIntercepted: 0,
    requestsSentToNetwork: 0,
    bytesFromNetwork: 0,
    bytesFromCache: 0,
    requestDetails: new Map()
  };
  
  // Track unique vs shared resources
  const resourceTypes = new Map<string, { count: number; urls: Set<string> }>();
  
  // Create log file
  const logFile = join(process.cwd(), `cache-experiment-${Date.now()}.log`);
  const logToFile = (msg: string) => {
    appendFileSync(logFile, `${new Date().toISOString()} - ${msg}\n`);
  };
  logToFile('=== Cache Experiment Log ===');
  logToFile(`Cache enabled: ${!options.noCache}`);
  logToFile(`Browser: ${options.local ? 'Local' : 'Browserbase'}`);
  logToFile('');
  
  try {
    // Always use residential proxy for accurate cache testing
    const proxy = await getProxyById('oxylabs-us-1');
    
    // Create session using SessionManager
    const session = await sessionManager.createSession({
      domain: 'cos.com',
      proxy: proxy,
      headless: options.local && !options.localHeaded  // Use headed mode only when --local-headed
    });
    
    log.normal(`Starting cache experiment with ${TEST_URLS.length} URLs...`);
    log.normal(`Cache: ${options.noCache ? 'DISABLED' : 'ENABLED'}`);
    log.normal(`Browser: ${options.local ? (options.localHeaded ? 'Local (headed)' : 'Local (headless)') : 'Browserbase'}`);
    
    // Create browser
    const blockImages = false; // We'll handle image blocking in the cache
    const browserResult = await createBrowserFromSession(session, {
      blockImages: blockImages
    });
    browser = browserResult.browser;
    
    const context = await browserResult.createContext();
    const page = await context.newPage();
    
    // Create and enable cache if not disabled
    let cache: RequestCache | null = null;
    if (!options.noCache) {
      cache = new RequestCache({
        maxSizeBytes: 100 * 1024 * 1024, // 100MB cache
        ttlSeconds: 300, // 5 minute TTL
        blockImages: true  // ALWAYS block images in cache for bandwidth savings
      });
      await cache.enableForPage(page);
      log.normal(`Cache enabled for page (image blocking: true)`);
    }
    
    // Enhanced cache tracking via CDP
    if (!options.local) {
      const cdpSession = await page.context().newCDPSession(page);
      await cdpSession.send('Network.enable');
      
      // Map request IDs to URLs
      const requestIdToUrl = new Map<string, string>();
      
      // Track requests
      cdpSession.on('Network.requestWillBeSent', (params) => {
        stats.requestsIntercepted++;
        const url = params.request.url;
        requestIdToUrl.set(params.requestId, url);
        
        if (!stats.requestDetails.has(url)) {
          stats.requestDetails.set(url, { fromCache: false, size: 0 });
        }
        
        // Categorize resource type
        let resourceType = 'other';
        if (url.includes('/_next/static/')) resourceType = 'static-js-css';
        else if (url.match(/\.(jpg|jpeg|png|gif|webp)/i)) resourceType = 'image';
        else if (url.includes('/api/')) resourceType = 'api';
        else if (url.endsWith('.js')) resourceType = 'external-js';
        else if (url.endsWith('.css')) resourceType = 'external-css';
        else if (url.includes('.com/') && !url.includes('/api/') && !url.includes('/_next/')) resourceType = 'html';
        
        if (!resourceTypes.has(resourceType)) {
          resourceTypes.set(resourceType, { count: 0, urls: new Set() });
        }
        const typeData = resourceTypes.get(resourceType)!;
        typeData.count++;
        typeData.urls.add(url);
        
        logToFile(`REQUEST: ${params.requestId} -> ${url}`);
      });
      
      // Track cache hits
      cdpSession.on('Network.requestServedFromCache', (params) => {
        stats.hits++;
        const url = requestIdToUrl.get(params.requestId) || params.requestId;
        logToFile(`CACHE HIT: ${params.requestId} -> ${url}`);
        log.debug(`Cache hit for: ${url}`);
      });
      
      // Track responses and sizes
      cdpSession.on('Network.responseReceived', (params) => {
        const url = params.response.url;
        const fromCache = params.response.fromDiskCache || params.response.fromServiceWorker;
        // Use headers Content-Length if encodedDataLength is 0
        const size = params.response.encodedDataLength || 
                    parseInt(params.response.headers['content-length'] || params.response.headers['Content-Length'] || '0') || 
                    0;
        
        logToFile(`RESPONSE: ${params.requestId} -> ${url} - ${(size/1024).toFixed(1)}KB - fromCache=${fromCache} - fromDisk=${params.response.fromDiskCache} - fromSW=${params.response.fromServiceWorker}`);
        
        if (fromCache) {
          stats.bytesFromCache += size;
          log.debug(`CACHE HIT: ${url.substring(0, 60)}... ${(size/1024).toFixed(1)}KB`);
        } else {
          stats.bytesFromNetwork += size;
          stats.requestsSentToNetwork++;
        }
        
        stats.requestDetails.set(url, { fromCache, size });
        
        // Debug large resources
        if (size > 50000) { // 50KB+
          const msg = `LARGE: ${url.substring(0, 80)}... - ${(size/1024).toFixed(1)}KB ${fromCache ? '(FROM CACHE)' : '(FROM NETWORK)'}`;
          log.normal(msg);
          logToFile(msg);
        }
      });
      
      // Track actual data received
      cdpSession.on('Network.loadingFinished', (params) => {
        if (params.encodedDataLength > 0) {
          const url = requestIdToUrl.get(params.requestId) || 'unknown';
          logToFile(`LOADED: ${params.requestId} -> ${url} - ${(params.encodedDataLength/1024).toFixed(1)}KB`);
          log.debug(`Loading finished: ${params.requestId} - ${(params.encodedDataLength/1024).toFixed(1)}KB`);
        }
      });
    }
    
    const startTime = Date.now();
    
    // Process each URL exactly once
    for (let i = 0; i < TEST_URLS.length; i++) {
      const url = TEST_URLS[i];
      log.normal(`[${i + 1}/${TEST_URLS.length}] Scraping: ${url}`);
      logToFile(`\n=== PAGE ${i + 1}/${TEST_URLS.length}: ${url} ===`);
      
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1000); // Brief wait for any dynamic content
      } catch (error) {
        const errorMsg = `Failed to scrape ${url}: ${error}`;
        log.error(errorMsg);
        errors.push(errorMsg);
      }
    }
    
    const endTime = Date.now();
    
    // Get actual cache stats if cache was used
    if (cache) {
      const cacheStats = cache.getStats();
      stats.hits = cacheStats.hits;
      stats.misses = cacheStats.misses;
      stats.bytesFromCache = cacheStats.bytesSaved;
      stats.bytesFromNetwork = cacheStats.bytesDownloaded;
      log.normal(`Cache stats from RequestCache: ${cacheStats.hits} hits, ${cacheStats.misses} misses, ${cacheStats.blockedImages} images blocked`);
    } else if (!options.noCache && stats.requestsIntercepted > 0) {
      // Fallback calculation if no cache object
      stats.misses = stats.requestsSentToNetwork;
    }
    
    // Log cache summary
    log.normal(`Cache summary: ${stats.hits} hits, ${stats.requestsSentToNetwork} network requests`);
    log.normal(`Bandwidth: ${(stats.bytesFromNetwork/1024/1024).toFixed(1)}MB from network, ${(stats.bytesFromCache/1024/1024).toFixed(1)}MB from cache`);
    
    logToFile(`\n=== FINAL SUMMARY ===`);
    logToFile(`Total requests: ${stats.requestsIntercepted}`);
    logToFile(`Cache hits: ${stats.hits}`);
    logToFile(`Network requests: ${stats.requestsSentToNetwork}`);
    logToFile(`Bytes from network: ${(stats.bytesFromNetwork/1024/1024).toFixed(2)}MB`);
    logToFile(`Bytes from cache: ${(stats.bytesFromCache/1024/1024).toFixed(2)}MB`);
    
    // Log resource type analysis
    if (!options.local && resourceTypes.size > 0) {
      logToFile(`\n=== RESOURCE TYPE ANALYSIS ===`);
      for (const [type, data] of resourceTypes.entries()) {
        const uniqueCount = data.urls.size;
        const duplicates = data.count - uniqueCount;
        logToFile(`${type}: ${data.count} requests, ${uniqueCount} unique URLs, ${duplicates} potential cache hits`);
      }
      
      // Calculate cache efficiency
      const totalStaticResources = (resourceTypes.get('static-js-css')?.urls.size || 0) + 
                                  (resourceTypes.get('external-js')?.urls.size || 0) + 
                                  (resourceTypes.get('external-css')?.urls.size || 0);
      const totalImages = resourceTypes.get('image')?.urls.size || 0;
      logToFile(`\nShared resources (JS/CSS): ${totalStaticResources} unique files`);
      logToFile(`Product images: ${totalImages} unique files`);
      logToFile(`\nCache is most effective for shared resources, less so for unique product content.`);
    }
    
    logToFile(`\nLog file saved to: ${logFile}`);
    log.normal(`\nDetailed log saved to: ${logFile}`);
    
    return { stats, duration: endTime - startTime, errors };
    
  } finally {
    if (browser) await browser.close();
    await sessionManager.destroyAllSessions();
  }
}

function displayResults(
  options: ExperimentOptions,
  stats: CacheStats,
  duration: number,
  errors: string[]
) {
  console.log('\n=== Cache Experiment Results ===\n');
  
  console.log('Configuration:');
  console.log(`- URLs tested: ${TEST_URLS.length}`);
  console.log(`- Cache enabled: ${options.noCache ? 'No' : 'Yes'}`);
  console.log(`- Browser: ${options.local ? (options.localHeaded ? 'Local (headed)' : 'Local (headless)') : 'Browserbase'}`);
  
  console.log('\nResults:');
  console.log(`- Items successfully scraped: ${TEST_URLS.length - errors.length}/${TEST_URLS.length}`);
  console.log(`- Total duration: ${(duration / 1000).toFixed(1)}s`);
  console.log(`- Average per URL: ${(duration / TEST_URLS.length / 1000).toFixed(1)}s`);
  
  if (!options.noCache && stats.requestsIntercepted > 0) {
    const hitRate = stats.hits > 0 ? (stats.hits / stats.requestsIntercepted) * 100 : 0;
    console.log('\nCache Performance:');
    console.log(`- Total requests: ${stats.requestsIntercepted}`);
    console.log(`- Cache hits: ${stats.hits}`);
    console.log(`- Cache misses: ${stats.misses}`);
    console.log(`- Cache hit rate: ${hitRate.toFixed(1)}%`);
    
    // Use actual bandwidth measurements
    const actualDownloadMB = stats.bytesFromNetwork / (1024 * 1024);
    const actualCacheMB = stats.bytesFromCache / (1024 * 1024);
    const totalBandwidthMB = actualDownloadMB + actualCacheMB;
    
    console.log('\nBandwidth Analysis (actual):');
    console.log(`- Network downloaded: ${actualDownloadMB.toFixed(1)} MB`);
    console.log(`- Served from cache: ${actualCacheMB.toFixed(1)} MB`);
    console.log(`- Total bandwidth if no cache: ${totalBandwidthMB.toFixed(1)} MB`);
    console.log(`- Bandwidth saved: ${actualCacheMB > 0 ? ((actualCacheMB / totalBandwidthMB) * 100).toFixed(1) : '0.0'}%`);
    
    // Debug info
    if (stats.hits > 0) {
      console.log('\nCache Debug:');
      console.log(`- Requests with size data: ${stats.requestDetails.size}`);
      console.log(`- Bytes tracked: ${((stats.bytesFromNetwork + stats.bytesFromCache) / 1024 / 1024).toFixed(1)} MB total`);
    }
    
    console.log('\nCost Analysis:');
    const costWithoutCache = calculateCost(totalBandwidthMB);
    const actualCost = calculateCost(actualDownloadMB);
    const savings = costWithoutCache - actualCost;
    const savingsPercent = costWithoutCache > 0 ? (savings / costWithoutCache) * 100 : 0;
    
    console.log(`- Cost without cache: $${costWithoutCache.toFixed(4)}`);
    console.log(`- Actual cost with cache: $${actualCost.toFixed(4)}`);
    console.log(`- Savings: $${savings.toFixed(4)} (${savingsPercent.toFixed(1)}%)`);
  } else if (options.noCache) {
    const estimatedTotalMB = TEST_URLS.length * ESTIMATED_PAGE_SIZE_MB;
    const cost = calculateCost(estimatedTotalMB);
    
    console.log('\nBandwidth Analysis:');
    console.log(`- Total downloaded: ~${estimatedTotalMB} MB`);
    console.log(`- Cost: $${cost.toFixed(4)}`);
    console.log('\nNote: Enable caching to see potential savings');
  } else if (options.local) {
    console.log('\nNote: Cache tracking not available with local browser');
  }
  
  if (errors.length > 0) {
    console.log('\nErrors:');
    errors.forEach(error => console.log(`- ${error}`));
  }
}

async function main() {
  try {
    const options = parseArgs();
    const { stats, duration, errors } = await runExperiment(options);
    displayResults(options, stats, duration, errors);
    
    if (!options.noCache) {
      console.log('\nTip: Run with --no-cache to see the cost without caching');
    } else {
      console.log('\nTip: Run without --no-cache to see the savings with caching enabled');
    }
    
    console.log('\n✓ Experiment complete. Processed all URLs once and exited.');
  } catch (error) {
    log.error('Cache experiment failed:', error);
    process.exit(1);
  }
}

main();