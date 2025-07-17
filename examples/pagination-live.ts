/**
 * Live example: Robust pagination with real scrapers and sites
 * 
 * This example demonstrates production-ready pagination using:
 * - Real site scrapers loaded from the codebase
 * - Actual browser sessions managed by SessionManager
 * - Live ETL API integration
 * - The distributor for intelligent URL-session matching
 * 
 * Features:
 * - SessionManager handles instance limit (max concurrent sessions)
 * - Distributor matches URLs to available sessions
 * - Handles proxy failures and blocklist
 * - Each site's pagination is independent
 * 
 * Usage:
 * npm run example:pagination:live -- --sites=amgbrand.com,blackseatribe.com --instance-limit=5
 */

import { SiteManager } from '../src/services/site-manager.js';
import { SessionManager } from '../src/services/session-manager.js';
import { targetsToSessions } from '../src/core/distributor.js';
import { logger } from '../src/utils/logger.js';
import { loadScraper } from '../src/drivers/scraper-loader.js';
import { createBrowserFromSession } from '../src/drivers/browser.js';
import { urlsToScrapeTargets } from '../src/utils/scrape-target-utils.js';
import type { Session } from '../src/types/session.js';
import type { SessionInfo } from '../src/core/distributor.js';
import type { Page } from 'playwright';

const log = logger.createContext('pagination-live');

interface SessionWithBrowser {
  session: Session;
  sessionInfo: SessionInfo;
  browser?: any;
  context?: any;
}

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const sitesArg = args.find(arg => arg.startsWith('--sites='));
  const instanceLimitArg = args.find(arg => arg.startsWith('--instance-limit='));
  
  if (!sitesArg) {
    console.error('Usage: npm run example:pagination:live -- --sites=site1.com,site2.com [--instance-limit=5]');
    process.exit(1);
  }
  
  const sites = sitesArg.replace('--sites=', '').split(',').map(s => s.trim());
  const instanceLimit = instanceLimitArg ? parseInt(instanceLimitArg.replace('--instance-limit=', '')) : 5;
  
  log.normal(`Will paginate ${sites.length} sites: ${sites.join(', ')}`);
  log.normal(`Instance limit: ${instanceLimit}`);
  
  // Initialize managers
  const siteManager = new SiteManager();
  const sessionManager = new SessionManager({ sessionLimit: instanceLimit });
  
  // Load sites from ETL API
  log.normal('Loading site configurations...');
  await siteManager.loadSites();
  
  // For session creation, we need to know which sites we're working with
  // to get their proxy configurations
  log.normal(`Creating ${instanceLimit} sessions...`);
  
  // Build session options with proper proxies
  const sessionOptions = await Promise.all(
    Array.from({ length: instanceLimit }, async (_, i) => {
      // For demo, rotate through sites for proxy selection
      // In production, you might have a different strategy
      const siteForProxy = sites[i % sites.length];
      const proxy = await siteManager.getProxyForDomain(siteForProxy);
      
      return { domain: siteForProxy, proxy };
    })
  );
  
  // Create all sessions in parallel using the new array syntax
  const createdSessions = await sessionManager.createSession(sessionOptions) as Session[];
  
  // Build session data with SessionInfo for distributor
  const sessions: SessionWithBrowser[] = createdSessions.map((session, i) => {
    const options = sessionOptions[i];
    const sessionInfo: SessionInfo = {
      id: `session-${i}`,
      proxyType: options.proxy?.type as any || 'none',
      proxyId: options.proxy?.id,
      proxyGeo: options.proxy?.geo
    };
    
    return { session, sessionInfo };
  });
  
  log.normal(`Created ${sessions.length} sessions in parallel`);
  
  // Create browsers for ALL sessions upfront
  log.normal('Creating browsers for sessions...');
  await Promise.all(sessions.map(async (sessionData) => {
    const { browser, createContext } = await createBrowserFromSession(sessionData.session);
    sessionData.browser = browser;
    sessionData.context = await createContext();
  }));
  log.normal('All browsers ready');
  
  // Process each site
  const results: Record<string, any> = {};
  
  for (const site of sites) {
    log.normal(`\n========== Processing ${site} ==========`);
    
    try {
      // Get site config
      const siteConfig = siteManager.getSite(site);
      if (!siteConfig) {
        throw new Error(`Site ${site} not found`);
      }
      
      if (!siteConfig.config.startPages?.length) {
        throw new Error(`No start pages for ${site}`);
      }
      
      // Load scraper
      const scraper = await loadScraper(site);
      log.normal(`Loaded scraper for ${site}`);
      
      // Start pagination tracking
      await siteManager.startPagination(site, siteConfig.config.startPages);
      
      // Get site configs with blocked proxies
      const siteConfigs = await siteManager.getSiteConfigsWithBlockedProxies();
      const currentSiteConfig = siteConfigs.find(c => c.domain === site);
      
      // Convert start pages to targets
      const targets = urlsToScrapeTargets(siteConfig.config.startPages);
      
      // Use distributor to match URLs to available sessions
      const urlSessionPairs = targetsToSessions(
        targets,
        sessions.map(s => s.sessionInfo),
        currentSiteConfig ? [currentSiteConfig] : []
      );
      
      log.normal(`Distributor assigned ${urlSessionPairs.length} URL-session pairs for ${site}`);
      
      // Process each URL-session pair
      const collectedUrls: string[] = [];
      const paginationPromises = urlSessionPairs.map(async (pair) => {
        const sessionData = sessions.find(s => s.sessionInfo.id === pair.sessionId);
        if (!sessionData?.browser) {
          throw new Error(`No browser for session ${pair.sessionId}`);
        }
        
        const startPage = pair.url;
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
          try {
            log.normal(`Paginating ${startPage} with session ${pair.sessionId} (attempt ${retryCount + 1})`);
            
            const page: Page = await sessionData.context.newPage();
            
            try {
              // Navigate to start page
              await page.goto(startPage, { 
                waitUntil: 'domcontentloaded',
                timeout: 30000 
              });
              
              // Pagination loop - collect URLs from multiple pages
              const pageUrls: string[] = [];
              let currentPage = 1;
              const maxPages = 5; // Limit for safety
              
              // Get URLs from first page
              const firstPageUrls = await scraper.getItemUrls(page);
              firstPageUrls.forEach(url => pageUrls.push(url));
              log.normal(`Page 1: Found ${firstPageUrls.size} items`);
              
              // Navigate through additional pages
              while (currentPage < maxPages) {
                const hasMore = await scraper.paginate(page);
                if (!hasMore) {
                  log.normal(`No more pages after page ${currentPage}`);
                  break;
                }
                
                currentPage++;
                const urls = await scraper.getItemUrls(page);
                urls.forEach(url => pageUrls.push(url));
                log.normal(`Page ${currentPage}: Found ${urls.size} items`);
              }
              
              // Update pagination state
              siteManager.updatePaginationState(startPage, {
                collectedUrls: pageUrls,
                completed: true
              });
              
              log.normal(`✓ Collected ${pageUrls.length} total URLs from ${startPage} (${currentPage} pages)`);
              collectedUrls.push(...pageUrls);
              break; // Success, exit retry loop
              
            } finally {
              await page.close();
            }
            
          } catch (error) {
            retryCount++;
            const errorMsg = error instanceof Error ? error.message : String(error);
            log.error(`Failed pagination attempt ${retryCount} for ${startPage}: ${errorMsg}`);
            
            // Track failure
            siteManager.updatePaginationState(startPage, {
              failureCount: retryCount,
              failureHistory: [{
                timestamp: new Date(),
                proxy: 'unknown', // In real implementation, get from session
                error: errorMsg
              }]
            });
            
            // Add proxy to blocklist if it's a network error
            if (errorMsg.includes('net::') || errorMsg.includes('timeout')) {
              // In a real implementation, we'd get the actual proxy from the session
              log.debug('Would add proxy to blocklist if we knew which one failed');
            }
            
            if (retryCount >= maxRetries) {
              // Mark as completed with no URLs
              siteManager.updatePaginationState(startPage, {
                collectedUrls: [],
                completed: true
              });
              throw new Error(`Failed after ${maxRetries} attempts`);
            }
            
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }
      });
      
      // Wait for all paginations to complete
      await Promise.allSettled(paginationPromises);
      
      // Try to commit the partial run
      try {
        const run = await siteManager.commitPartialRun(site);
        log.normal(`✓ Successfully committed run ${run.id} for ${site} with ${run.items.length} URLs`);
        results[site] = { success: true, urls: collectedUrls };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error(`✗ Failed to commit run for ${site}: ${errorMsg}`);
        results[site] = { success: false, urls: collectedUrls, error: errorMsg };
      }
      
      // Show blocked proxies
      const blockedProxies = await siteManager.getBlockedProxies(site);
      if (blockedProxies.length > 0) {
        log.normal(`Blocked proxies for ${site}: ${blockedProxies.join(', ')}`);
      }
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Failed to process ${site}: ${errorMsg}`);
      results[site] = { success: false, urls: [], error: errorMsg };
    }
  }
  
  // Clean up all browsers
  for (const sessionData of sessions) {
    if (sessionData.browser) {
      try {
        await sessionData.browser.close();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
  
  // Summary
  log.normal('\n========== SUMMARY ==========');
  for (const [site, result] of Object.entries(results)) {
    if (result.success) {
      log.normal(`✓ ${site}: SUCCESS - ${result.urls.length} URLs collected`);
    } else {
      log.error(`✗ ${site}: FAILED - ${result.error} (collected ${result.urls.length} URLs before failure)`);
    }
  }
  
  // Check for uncommitted runs
  const uncommitted = siteManager.getSitesWithPartialRuns();
  if (uncommitted.length > 0) {
    log.error(`\nWarning: Uncommitted partial runs remain for: ${uncommitted.join(', ')}`);
  }
}

// Run the example
main().catch(error => {
  log.error('Example failed:', error);
  process.exit(1);
});