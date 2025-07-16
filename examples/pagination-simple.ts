#!/usr/bin/env tsx --env-file=.env

/**
 * Simple Pagination Example
 * 
 * Demonstrates basic pagination without the complexity of the distributor
 */

import { SessionManager } from '../src/services/session-manager.js';
import { SiteManager } from '../src/services/site-manager.js';
import { createBrowserFromSession } from '../src/drivers/browser.js';
import { logger } from '../src/utils/logger.js';
import { loadScraper } from '../src/drivers/scraper-loader.js';

const log = logger.createContext('pagination-simple');

async function main() {
  const domain = process.argv[2] || 'iam-store.com';
  
  const sessionManager = new SessionManager();
  const siteManager = new SiteManager();

  try {
    // Initialize
    await siteManager.loadSites();
    const siteConfig = siteManager.getSiteConfig(domain);
    if (!siteConfig) {
      throw new Error(`No site config for ${domain}`);
    }
    
    // Create a session
    const session = await sessionManager.createSession();
    log.normal(`Created session`);
    
    // Load scraper
    const scraper = await loadScraper(domain);
    log.normal(`Loaded scraper for ${domain}`);
    
    // Create browser
    const { browser, createContext } = await createBrowserFromSession(session);
    const context = await createContext();
    const page = await context.newPage();
    
    // Start at first page
    const startUrl = siteConfig.startPages?.[0];
    if (!startUrl) {
      throw new Error(`No start URL for ${domain}`);
    }
    
    log.normal(`Navigating to ${startUrl}`);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Paginate through pages
    let pageCount = 1;
    const allUrls = new Set<string>();
    
    do {
      // Get URLs from current page
      const urls = await scraper.getItemUrls(page);
      log.normal(`Page ${pageCount}: Found ${urls.size} item URLs`);
      urls.forEach(url => allUrls.add(url));
      
      // Try to go to next page
      const hasMore = await scraper.paginate(page);
      if (!hasMore) {
        log.normal('No more pages');
        break;
      }
      
      pageCount++;
      if (pageCount > 5) {
        log.normal('Stopping at 5 pages for demo');
        break;
      }
    } while (true);
    
    // Results
    log.normal(`Total URLs discovered: ${allUrls.size}`);
    log.normal('Sample URLs:', Array.from(allUrls).slice(0, 5));
    
    // Cleanup
    await page.close();
    await context.close();
    await browser.close();
    await sessionManager.destroySessionByObject(session);
    
  } catch (error) {
    log.error(`Error: ${error.message}`);
    await sessionManager.destroyAllSessions();
    process.exit(1);
  }
}

main();