#!/usr/bin/env tsx --env-file=.env

/**
 * Pagination Example
 * 
 * This example demonstrates how to scrape a site with pagination,
 * handling retries and managing sessions properly.
 * 
 * Usage: npm run example:pagination <domain>
 * Example: npm run example:pagination blackseatribe.com
 * 
 * Architecture notes:
 * - Uses SessionManager (service) to manage browser sessions
 * - Uses SiteManager (service) to get site configs
 * - Uses createBrowserFromSession (driver) to create browsers
 * - Uses loadScraper (driver) to load scrapers - proper architecture!
 * - Uses itemsToSessions (core) for URL-session distribution
 * 
 * NOTE: This example directly uses scrapers which normally would be
 * handled by a service or engine layer. This is for demonstration only.
 */

import { SessionManager } from '../src/services/session-manager.js';
import { SiteManager } from '../src/services/site-manager.js';
import { createBrowserFromSession } from '../src/drivers/browser.js';
import { itemsToSessions } from '../src/core/distributor.js';
import { logger } from '../src/utils/logger.js';
import { loadScraper } from '../src/drivers/scraper-loader.js';
import type { ScrapeRunItem } from '../src/types/scrape-run.js';

const log = logger.createContext('pagination-example');

async function paginateWithRetries(options: {
  sessionManager: SessionManager;
  siteManager: SiteManager;
  domain: string;
  maxRetries: number;
}) {
  const { sessionManager, siteManager, domain, maxRetries = 2 } = options;
  
  // Load scraper for domain
  const scraper = await loadScraper(domain);
  log.normal(`Loaded scraper for domain: ${domain}`);

  // Get site config and start URL
  const siteConfig = siteManager.getSiteConfig(domain);
  if (!siteConfig) {
    throw new Error(`No site config found for domain: ${domain}`);
  }
  
  const startUrl = siteConfig.startPages?.[0];
  if (!startUrl) {
    throw new Error(`No start pages configured for domain: ${domain}`);
  }

  // Track retry counts and discovered URLs
  const retryCount = new Map<string, number>();
  const allDiscoveredUrls = new Set<string>();
  const processedUrls = new Set<string>();

  // Start with the start URL
  let currentBatch: ScrapeRunItem[] = [{ 
    url: startUrl, 
    done: false, 
    failed: 0, 
    invalid: false 
  }];

  // Main pagination loop
  while (currentBatch.length > 0) {
    log.normal(`Processing batch of ${currentBatch.length} URLs`);
    
    // Get available sessions
    const sessions = await sessionManager.getActiveSessions();
    log.normal(`Available sessions: ${sessions.length}`);
    
    // Map Sessions to SessionInfo format for distributor
    const sessionInfos = sessions.map((session, index) => ({
      id: session.browserbase?.id || `local-${index}`,
      proxyType: 'residential' as const, // Match what the site needs
    }));
    
    // Filter valid items
    const validItems = currentBatch.filter(item => !item.done && !item.invalid);
    log.normal(`Valid items to process: ${validItems.length}`);
    
    // Run double matcher to assign URLs to sessions
    const matches = itemsToSessions(
      validItems,
      sessionInfos,
      [siteConfig]
    );

    log.normal(`Matched ${matches.length} URLs to sessions`);

    // Process each matched URL-session pair
    const newUrls = new Set<string>();

    for (const match of matches) {
      const { url, sessionId } = match;
      
      // Find the actual session object
      const session = sessions.find(s => 
        (s.browserbase?.id || `local-${sessions.indexOf(s)}`) === sessionId
      );
      
      if (!session) {
        log.error(`Session ${sessionId} not found`);
        continue;
      }
      
      try {
        log.normal(`Processing ${url} with session ${sessionId}`);
        processedUrls.add(url);
        
        // Create browser from session
        const { browser, createContext } = await createBrowserFromSession(session);
        const context = await createContext();
        const page = await context.newPage();
        
        // Navigate to URL
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Extract item URLs from current page
        const itemUrls = await scraper.getItemUrls(page);
        log.normal(`Found ${itemUrls.size} item URLs on ${url}`);
        
        // Add new URLs to discovered set
        itemUrls.forEach(itemUrl => {
          allDiscoveredUrls.add(itemUrl);
          if (!processedUrls.has(itemUrl)) {
            newUrls.add(itemUrl);
          }
        });
        
        // Try to paginate
        const hasNext = await scraper.paginate(page);
        
        if (hasNext) {
          // Add next page URL to process
          const nextPageUrl = page.url();
          if (!processedUrls.has(nextPageUrl)) {
            newUrls.add(nextPageUrl);
            log.normal(`Next page found: ${nextPageUrl}`);
          }
        }
        
        // Cleanup
        await page.close();
        await context.close();
        await browser.close();
        
      } catch (error) {
        log.error(`Failed to process ${url}: ${error.message}`);
        
        // Track retry count
        const retries = (retryCount.get(url) || 0) + 1;
        retryCount.set(url, retries);
        
        if (retries < maxRetries) {
          log.normal(`Will retry ${url} (attempt ${retries}/${maxRetries})`);
          // Add back to batch for retry
          newUrls.add(url);
        } else {
          log.error(`Max retries reached for ${url}, skipping`);
        }
      }
    }

    // Prepare next batch from new URLs
    currentBatch = Array.from(newUrls).map(url => ({ 
      url, 
      done: false, 
      failed: retryCount.get(url) || 0,
      invalid: false 
    }));
    
    log.normal(`Next batch: ${currentBatch.length} URLs`);
  }

  log.normal(`Pagination complete. Discovered ${allDiscoveredUrls.size} total URLs`);
  return { 
    totalUrls: allDiscoveredUrls.size,
    processedUrls: processedUrls.size,
    urls: Array.from(allDiscoveredUrls)
  };
}

// Main function
async function main() {
  const domain = process.argv[2];
  
  if (!domain) {
    console.error('Usage: npm run example:pagination <domain>');
    console.error('Example: npm run example:pagination blackseatribe.com');
    process.exit(1);
  }

  const sessionManager = new SessionManager();
  const siteManager = new SiteManager();

  try {
    // Initialize site manager
    await siteManager.loadSites();
    
    // Create initial sessions
    const sessionCount = 3; // Start with 3 sessions
    for (let i = 0; i < sessionCount; i++) {
      await sessionManager.createSession();
    }
    log.normal(`Created ${sessionCount} sessions`);

    // Run pagination with retries
    const result = await paginateWithRetries({
      sessionManager,
      siteManager,
      domain,
      maxRetries: 2,
    });

    log.normal(`Final result: Found ${result.totalUrls} URLs total`);
    log.normal(`Sample URLs:`, result.urls.slice(0, 5));

  } catch (error) {
    log.error(`Pagination failed: ${error.message}`);
    process.exit(1);
  } finally {
    // Cleanup
    await sessionManager.destroyAllSessions();
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}