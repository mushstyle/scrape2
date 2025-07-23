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
 *   npm run example:cache-experiment -- --local        # Use local browser
 */

import { createBrowserFromSession } from '../src/drivers/browser.js';
import { SessionManager } from '../src/services/session-manager.js';
import { getProxyById } from '../src/drivers/proxy.js';
import { logger } from '../src/utils/logger.js';
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
}

interface CacheStats {
  hits: number;
  misses: number;
  requestsIntercepted: number;
}

function parseArgs(): ExperimentOptions {
  const args = process.argv.slice(2);
  return {
    noCache: args.includes('--no-cache'),
    local: args.includes('--local')
  };
}

function calculateCost(mbDownloaded: number): number {
  return (mbDownloaded / 1024) * COST_PER_GB;
}

async function runExperiment(options: ExperimentOptions): Promise<{ stats: CacheStats; duration: number; errors: string[] }> {
  const sessionManager = new SessionManager();
  let browser: Browser | null = null;
  const errors: string[] = [];
  const stats: CacheStats = { hits: 0, misses: 0, requestsIntercepted: 0 };
  
  try {
    // Always use residential proxy for accurate cache testing
    const proxy = await getProxyById('oxylabs-us-1');
    
    // Create session using SessionManager
    const session = await sessionManager.createSession({
      domain: 'cos.com',
      proxy: proxy,
      localHeadless: options.local  // Use headless mode when local
    });
    
    log.normal(`Starting cache experiment with ${TEST_URLS.length} URLs...`);
    log.normal(`Cache: ${options.noCache ? 'DISABLED' : 'ENABLED'}`);
    log.normal(`Browser: ${options.local ? 'Local' : 'Browserbase'}`);
    
    // Create browser with cache settings
    const browserResult = await createBrowserFromSession(session, {
      blockImages: true
    });
    browser = browserResult.browser;
    
    const context = await browserResult.createContext({
      cache: options.noCache ? undefined : {} // Enable cache if not disabled
    });
    const page = await context.newPage();
    
    // Simple cache tracking via CDP if not local
    if (!options.local && !options.noCache) {
      const cdpSession = await page.context().newCDPSession(page);
      await cdpSession.send('Network.enable');
      
      cdpSession.on('Network.requestServedFromCache', () => {
        stats.hits++;
      });
      
      cdpSession.on('Network.requestWillBeSent', () => {
        stats.requestsIntercepted++;
      });
    }
    
    const startTime = Date.now();
    
    // Process each URL exactly once
    for (let i = 0; i < TEST_URLS.length; i++) {
      const url = TEST_URLS[i];
      log.normal(`[${i + 1}/${TEST_URLS.length}] Scraping: ${url}`);
      
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
    
    // Calculate misses
    if (!options.noCache && stats.requestsIntercepted > 0) {
      stats.misses = stats.requestsIntercepted - stats.hits;
    }
    
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
  console.log(`- Browser: ${options.local ? 'Local' : 'Browserbase'}`);
  
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
    
    // Estimate bandwidth (very rough)
    const estimatedDownloadMB = (stats.misses / 100) * ESTIMATED_PAGE_SIZE_MB; // Assume ~100 requests per page
    const estimatedSavedMB = (stats.hits / 100) * ESTIMATED_PAGE_SIZE_MB;
    const totalBandwidthMB = estimatedDownloadMB + estimatedSavedMB;
    
    console.log('\nBandwidth Analysis (estimated):');
    console.log(`- Network downloaded: ~${estimatedDownloadMB.toFixed(1)} MB`);
    console.log(`- Served from cache: ~${estimatedSavedMB.toFixed(1)} MB`);
    console.log(`- Total bandwidth needed: ~${totalBandwidthMB.toFixed(1)} MB`);
    console.log(`- Bandwidth saved: ${estimatedSavedMB > 0 ? ((estimatedSavedMB / totalBandwidthMB) * 100).toFixed(1) : '0.0'}%`);
    
    console.log('\nCost Analysis:');
    const costWithoutCache = calculateCost(totalBandwidthMB);
    const actualCost = calculateCost(estimatedDownloadMB);
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