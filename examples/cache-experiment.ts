#!/usr/bin/env tsx --env-file=.env
/**
 * Cache Experiment Example
 * 
 * Demonstrates the effectiveness of caching by scraping a fixed set of URLs
 * with and without caching enabled. Shows bandwidth usage and cost savings.
 * 
 * Usage:
 *   npm run example:cache-experiment                    # Run with caching (default)
 *   npm run example:cache-experiment -- --no-cache     # Run without caching
 *   npm run example:cache-experiment -- --cache-size-mb 500 --cache-ttl 600
 *   npm run example:cache-experiment -- --local        # Use local browser
 */

import { SessionManager } from '../src/services/session-manager.js';
import { SiteManager } from '../src/services/site-manager.js';
import { ScrapeItemEngine } from '../src/engines/scrape-item-engine.js';
import { logger } from '../src/utils/logger.js';
import type { ScrapeItemOptions, ScrapeItemResult } from '../src/engines/scrape-item-engine.js';

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

interface ExperimentOptions {
  noCache: boolean;
  cacheSizeMB: number;
  cacheTTLSeconds: number;
  local: boolean;
}

function parseArgs(): ExperimentOptions {
  const args = process.argv.slice(2);
  
  return {
    noCache: args.includes('--no-cache'),
    cacheSizeMB: parseInt(args.find(arg => arg.startsWith('--cache-size-mb'))?.split(/[= ]/)[1] || '250'),
    cacheTTLSeconds: parseInt(args.find(arg => arg.startsWith('--cache-ttl'))?.split(/[= ]/)[1] || '300'),
    local: args.includes('--local')
  };
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function calculateCost(mbDownloaded: number): number {
  return (mbDownloaded / 1024) * COST_PER_GB;
}

async function runExperiment(options: ExperimentOptions) {
  const siteManager = new SiteManager({ autoLoad: false });
  const sessionManager = new SessionManager();
  
  const engine = new ScrapeItemEngine(siteManager, sessionManager);
  
  try {
    await siteManager.loadSites();
    
    const sites = ['cos.com'];
    for (const site of sites) {
      const run = await siteManager.createRun(site, TEST_URLS);
      log.debug(`Created run ${run.id} for ${site} with ${TEST_URLS.length} URLs`);
    }
    
    const scrapeOptions: ScrapeItemOptions = {
      sites,
      instanceLimit: 1,
      itemLimit: 10,
      disableCache: options.noCache,
      cacheSizeMB: options.cacheSizeMB,
      cacheTTLSeconds: options.cacheTTLSeconds,
      noSave: true,
      retryFailedItems: false
    };
    
    if (options.local) {
      scrapeOptions.localHeadless = true;
    }
    
    log.normal(`Starting cache experiment with ${TEST_URLS.length} URLs...`);
    log.normal(`Cache: ${options.noCache ? 'DISABLED' : 'ENABLED'}`);
    if (!options.noCache) {
      log.normal(`Cache size: ${options.cacheSizeMB} MB, TTL: ${options.cacheTTLSeconds}s`);
    }
    
    const startTime = Date.now();
    const result = await engine.scrapeItems(scrapeOptions);
    const endTime = Date.now();
    
    return { result, duration: endTime - startTime };
  } finally {
    await sessionManager.destroyAllSessions();
  }
}

async function displayResults(
  options: ExperimentOptions,
  result: ScrapeItemResult,
  duration: number
) {
  console.log('\n=== Cache Experiment Results ===\n');
  
  console.log('Configuration:');
  console.log(`- URLs tested: ${TEST_URLS.length}`);
  console.log(`- Cache enabled: ${options.noCache ? 'No' : 'Yes'}`);
  if (!options.noCache) {
    console.log(`- Cache size: ${options.cacheSizeMB} MB`);
    console.log(`- Cache TTL: ${options.cacheTTLSeconds} seconds`);
  }
  console.log(`- Browser: ${options.local ? 'Local' : 'Browserbase'}`);
  
  console.log('\nResults:');
  console.log(`- Items successfully scraped: ${result.itemsScraped}/${TEST_URLS.length}`);
  console.log(`- Total duration: ${(duration / 1000).toFixed(1)}s`);
  
  if (result.cacheStats && !options.noCache) {
    const stats = result.cacheStats;
    console.log(`- Cache hits: ${stats.hits}`);
    console.log(`- Cache misses: ${stats.misses}`);
    console.log(`- Cache hit rate: ${stats.hitRate.toFixed(1)}%`);
    console.log(`- Total cache size: ${stats.totalSizeMB.toFixed(1)} MB`);
    
    const estimatedDownloadMB = stats.misses * 5;
    const estimatedSavedMB = stats.hits * 5;
    const totalBandwidthMB = estimatedDownloadMB + estimatedSavedMB;
    
    console.log('\nBandwidth Analysis (estimated):');
    console.log(`- Network downloaded: ~${estimatedDownloadMB} MB`);
    console.log(`- Served from cache: ~${estimatedSavedMB} MB`);
    console.log(`- Total bandwidth needed: ~${totalBandwidthMB} MB`);
    console.log(`- Bandwidth saved: ${((estimatedSavedMB / totalBandwidthMB) * 100).toFixed(1)}%`);
    
    console.log('\nCost Analysis:');
    const costWithoutCache = calculateCost(totalBandwidthMB);
    const actualCost = calculateCost(estimatedDownloadMB);
    const savings = costWithoutCache - actualCost;
    const savingsPercent = (savings / costWithoutCache) * 100;
    
    console.log(`- Cost without cache: $${costWithoutCache.toFixed(3)}`);
    console.log(`- Actual cost with cache: $${actualCost.toFixed(3)}`);
    console.log(`- Savings: $${savings.toFixed(3)} (${savingsPercent.toFixed(1)}%)`);
  } else if (options.noCache) {
    const estimatedTotalMB = result.itemsScraped * 5;
    const cost = calculateCost(estimatedTotalMB);
    
    console.log('\nBandwidth Analysis:');
    console.log(`- Total downloaded: ~${estimatedTotalMB} MB`);
    console.log(`- Cost: $${cost.toFixed(3)}`);
    console.log('\nNote: Enable caching to see potential savings');
  }
  
  if (result.errors.size > 0) {
    console.log('\nErrors:');
    for (const [url, error] of result.errors) {
      console.log(`- ${url}: ${error}`);
    }
  }
  
  console.log('\nCache Performance:');
  if (!options.noCache && result.cacheStats) {
    console.log(`- Cache hits: ${result.cacheStats.hits}`);
    console.log(`- Cache misses: ${result.cacheStats.misses}`);
    console.log(`- Total requests: ${result.cacheStats.hits + result.cacheStats.misses}`);
  } else {
    console.log('- Cache disabled for this run');
  }
}

async function main() {
  try {
    const options = parseArgs();
    const { result, duration } = await runExperiment(options);
    await displayResults(options, result, duration);
    
    if (!options.noCache) {
      console.log('\nTip: Run with --no-cache to see the cost without caching');
    } else {
      console.log('\nTip: Run without --no-cache to see the savings with caching enabled');
    }
  } catch (error) {
    log.error('Cache experiment failed:', error);
    process.exit(1);
  }
}

main();