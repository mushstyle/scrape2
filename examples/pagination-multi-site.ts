#!/usr/bin/env tsx --env-file=.env

/**
 * Multi-Site Pagination Example
 * 
 * Demonstrates concurrent pagination across multiple sites while respecting:
 * - Global instanceLimit (total concurrent sessions)
 * - Per-site sessionLimit (max concurrent sessions per site)
 */

import { SessionManager } from '../src/services/session-manager.js';
import { SiteManager } from '../src/services/site-manager.js';
import { createBrowserFromSession } from '../src/drivers/browser.js';
import { logger } from '../src/utils/logger.js';
import { loadScraper } from '../src/drivers/scraper-loader.js';
import type { Session } from '../src/types/session.js';
import type { Page } from 'playwright';

const log = logger.createContext('pagination-multi-site');

interface SiteWorker {
  domain: string;
  session: Session;
  page: Page;
  scraper: any;
  urls: Set<string>;
  pageCount: number;
  done: boolean;
}

async function paginateSite(worker: SiteWorker): Promise<void> {
  try {
    // Get URLs from current page
    const urls = await worker.scraper.getItemUrls(worker.page);
    log.normal(`${worker.domain} - Page ${worker.pageCount}: Found ${urls.size} URLs`);
    urls.forEach(url => worker.urls.add(url));
    
    // Try to go to next page
    const hasMore = await worker.scraper.paginate(worker.page);
    if (!hasMore || worker.pageCount >= 3) { // Limit to 3 pages per site for demo
      log.normal(`${worker.domain} - Completed (${worker.pageCount} pages, ${worker.urls.size} total URLs)`);
      worker.done = true;
      return;
    }
    
    worker.pageCount++;
  } catch (error) {
    log.error(`${worker.domain} - Error during pagination: ${error.message}`);
    worker.done = true;
  }
}

async function main() {
  // Parse command line args for domains and instanceLimit
  const args = process.argv.slice(2);
  let instanceLimit = 5; // Default
  let provider: 'browserbase' | 'local' = 'browserbase';
  const domains: string[] = [];
  
  // Parse args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--instance-limit' && i + 1 < args.length) {
      instanceLimit = parseInt(args[i + 1], 10);
      i++; // Skip next arg
    } else if (args[i] === '--local') {
      provider = 'local';
    } else if (!args[i].startsWith('--')) {
      domains.push(args[i]);
    }
  }
  
  if (domains.length === 0) {
    console.log('Usage: npm run example:pagination-multi <domain1> <domain2> ... [-- --instance-limit N] [-- --local]');
    console.log('Example: npm run example:pagination-multi iam-store.com amgbrand.com -- --instance-limit 5');
    console.log('Or with local: npm run example:pagination-multi iam-store.com amgbrand.com -- --local');
    process.exit(1);
  }
  
  log.normal(`Starting with instanceLimit: ${instanceLimit}, provider: ${provider}, domains: ${domains.join(', ')}`);
  
  // Create SessionManager with the instanceLimit
  const sessionManager = new SessionManager({ 
    sessionLimit: instanceLimit,
    provider
  });
  const siteManager = new SiteManager();
  const workers: SiteWorker[] = [];

  try {
    // Initialize
    await siteManager.loadSites();
    
    // Check domains and their limits
    const sitesToScrape: Array<{ domain: string; sessionLimit: number }> = [];
    for (const domain of domains) {
      const siteConfig = siteManager.getSiteConfig(domain);
      if (!siteConfig) {
        log.error(`No config for ${domain}, skipping`);
        continue;
      }
      if (!siteConfig.startPages?.length) {
        log.error(`No start pages for ${domain}, skipping`);
        continue;
      }
      
      const sessionLimit = siteConfig.proxy?.sessionLimit || 1;
      sitesToScrape.push({ domain, sessionLimit });
      log.normal(`Will scrape ${domain} with sessionLimit: ${sessionLimit}`);
    }
    
    if (sitesToScrape.length === 0) {
      throw new Error('No valid sites to scrape');
    }
    
    // Create sessions respecting both global and per-site limits
    let totalSessions = 0;
    for (const { domain, sessionLimit } of sitesToScrape) {
      const siteConfig = siteManager.getSiteConfig(domain)!;
      const scraper = await loadScraper(domain);
      
      // Calculate how many sessions we can create for this site
      const sessionsForSite = Math.min(
        sessionLimit, // Site's limit
        instanceLimit - totalSessions, // Remaining global capacity
        siteConfig.startPages.length, // Number of start pages
        2 // Limit to 2 per site for demo to avoid rate limits
      );
      
      if (sessionsForSite <= 0) {
        log.normal(`Reached global instance limit, skipping ${domain}`);
        continue;
      }
      
      log.normal(`Creating ${sessionsForSite} sessions for ${domain}`);
      
      // Create workers for this site
      for (let i = 0; i < sessionsForSite; i++) {
        // Add delay to avoid rate limits
        if (totalSessions > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
        }
        
        const session = await sessionManager.createSession({ domain });
        const { browser, createContext } = await createBrowserFromSession(session);
        const context = await createContext();
        const page = await context.newPage();
        
        // Navigate to start page
        const startUrl = siteConfig.startPages[i];
        log.normal(`${domain} worker ${i + 1}: Navigating to ${startUrl}`);
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        workers.push({
          domain,
          session,
          page,
          scraper,
          urls: new Set(),
          pageCount: 1,
          done: false
        });
        
        totalSessions++;
      }
    }
    
    log.normal(`\nCreated ${workers.length} total workers across ${sitesToScrape.length} sites`);
    log.normal('Starting concurrent pagination...\n');
    
    // Paginate all sites concurrently
    let iteration = 0;
    while (workers.some(w => !w.done)) {
      iteration++;
      log.normal(`\n--- Iteration ${iteration} ---`);
      
      // Run pagination for all active workers in parallel
      const activeWorkers = workers.filter(w => !w.done);
      await Promise.all(activeWorkers.map(worker => paginateSite(worker)));
      
      // Brief pause between iterations
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Summary
    log.normal('\n=== Final Results ===');
    const groupedByDomain = workers.reduce((acc, worker) => {
      if (!acc[worker.domain]) {
        acc[worker.domain] = {
          urls: new Set<string>(),
          pages: 0
        };
      }
      worker.urls.forEach(url => acc[worker.domain].urls.add(url));
      acc[worker.domain].pages = Math.max(acc[worker.domain].pages, worker.pageCount);
      return acc;
    }, {} as Record<string, { urls: Set<string>; pages: number }>);
    
    for (const [domain, data] of Object.entries(groupedByDomain)) {
      log.normal(`${domain}: ${data.pages} pages scraped, ${data.urls.size} unique URLs found`);
      log.normal(`  Sample URLs: ${Array.from(data.urls).slice(0, 3).join(', ')}`);
    }
    
    const totalUrls = Object.values(groupedByDomain).reduce((sum, data) => sum + data.urls.size, 0);
    log.normal(`\nTotal URLs across all sites: ${totalUrls}`);
    
    // Cleanup
    log.normal('\nCleaning up...');
    for (const worker of workers) {
      await worker.page.close();
      await worker.page.context().close();
      await worker.page.context().browser()?.close();
    }
    await sessionManager.destroyAllSessions();
    log.normal('Done!');
    
  } catch (error) {
    log.error(`Error: ${error.message}`);
    await sessionManager.destroyAllSessions();
    process.exit(1);
  }
}

main();