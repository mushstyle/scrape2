/**
 * Live example: Robust pagination with real scrapers and sites
 * 
 * This example demonstrates production-ready pagination using:
 * - Real site scrapers loaded from the codebase
 * - Actual browser sessions with Playwright
 * - Live ETL API integration
 * - The distributor for intelligent URL-session matching
 * 
 * Features:
 * - Uses session manager's instance limit for concurrent pagination
 * - Handles proxy failures and blocklist
 * - Each site's pagination is independent (one site failing doesn't affect others)
 * - Respects site-specific session limits
 * 
 * Usage:
 * npm run example:pagination:live -- --sites=amgbrand.com,blackseatribe.com --instance-limit=5
 */

import { SiteManager } from '../src/services/site-manager.js';
import { SessionManager } from '../src/services/session-manager.js';
import { itemsToSessions } from '../src/core/distributor.js';
import { logger } from '../src/utils/logger.js';
import { loadScraper } from '../src/drivers/scraper-loader.js';
import { createBrowserFromSession } from '../src/drivers/browser.js';
import type { ScrapeTarget } from '../src/types/scrape-target.js';
import type { SessionInfo } from '../src/core/distributor.js';
import type { Session } from '../src/types/session.js';
import type { Page } from 'playwright';

const log = logger.createContext('robust-pagination-example');

interface SessionWithBrowser {
  session: Session;
  sessionInfo: SessionInfo;
  browser?: any;
  context?: any;
}

async function paginateSite(
  domain: string,
  siteManager: SiteManager,
  sessionManager: SessionManager,
  maxSessionsOverride?: number
): Promise<{ success: boolean; urls: string[]; error?: string }> {
  const collectedUrls: string[] = [];
  const sessions: SessionWithBrowser[] = [];
  
  try {
    // Get site config
    const siteConfig = siteManager.getSite(domain);
    if (!siteConfig) {
      throw new Error(`Site ${domain} not found`);
    }
    
    if (!siteConfig.config.startPages?.length) {
      throw new Error(`No start pages for ${domain}`);
    }
    
    // Load scraper
    const scraper = await loadScraper(domain);
    log.normal(`Loaded scraper for ${domain}`);
    
    // Determine session limit
    const siteSessionLimit = await siteManager.getSessionLimitForDomain(domain);
    const effectiveLimit = Math.min(
      maxSessionsOverride || sessionManager.getMaxSessions(),
      siteSessionLimit,
      siteConfig.config.startPages.length
    );
    
    log.normal(`${domain}: Using ${effectiveLimit} sessions (site limit: ${siteSessionLimit}, max: ${sessionManager.getMaxSessions()})`);
    
    // Start pagination tracking
    await siteManager.startPagination(domain, siteConfig.config.startPages);
    
    // Create sessions
    for (let i = 0; i < effectiveLimit; i++) {
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Rate limit
      }
      
      const proxy = await siteManager.getProxyForDomain(domain);
      const session = await sessionManager.createSession({ 
        domain,
        proxy 
      });
      
      sessions.push({
        session,
        sessionInfo: {
          id: `session-${i}`,
          proxyType: proxy?.type as any,
          proxyId: proxy?.id,
          proxyGeo: proxy?.geo
        }
      });
    }
    
    log.normal(`Created ${sessions.length} sessions for ${domain}`);
    
    // Get site configs with blocked proxies
    const siteConfigs = await siteManager.getSiteConfigsWithBlockedProxies();
    const currentSiteConfig = siteConfigs.find(c => c.domain === domain);
    
    // Convert start pages to targets
    const targets: ScrapeTarget[] = siteConfig.config.startPages.map(url => ({
      url,
      done: false,
      failed: false,
      invalid: false
    }));
    
    // Use distributor to match URLs to sessions
    const urlSessionPairs = itemsToSessions(
      targets,
      sessions.map(s => s.sessionInfo),
      currentSiteConfig ? [currentSiteConfig] : []
    );
    
    log.normal(`Distributor assigned ${urlSessionPairs.length} URL-session pairs`);
    
    // Create browsers for sessions that will be used
    const usedSessionIds = new Set(urlSessionPairs.map(pair => pair.sessionId));
    for (const sessionData of sessions) {
      if (usedSessionIds.has(sessionData.sessionInfo.id)) {
        const { browser, context } = await createBrowserFromSession(sessionData.session);
        sessionData.browser = browser;
        sessionData.context = context;
      }
    }
    
    // Process each URL-session pair
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
            
            // Run scraper's paginate method
            const urls = await scraper.paginate(page, domain);
            
            // Update pagination state
            siteManager.updatePaginationState(startPage, {
              collectedUrls: urls,
              completed: true
            });
            
            log.normal(`✓ Collected ${urls.length} URLs from ${startPage}`);
            collectedUrls.push(...urls);
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
              proxy: sessionData.sessionInfo.proxyId || 'unknown',
              error: errorMsg
            }]
          });
          
          // Add proxy to blocklist if it's a network error
          if (sessionData.sessionInfo.proxyId && 
              sessionData.sessionInfo.proxyType === 'datacenter' &&
              (errorMsg.includes('net::') || errorMsg.includes('timeout'))) {
            await siteManager.addProxyToBlocklist(domain, sessionData.sessionInfo.proxyId, errorMsg);
            log.debug(`Added proxy ${sessionData.sessionInfo.proxyId} to blocklist`);
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
    
    // Clean up browsers
    for (const sessionData of sessions) {
      if (sessionData.browser) {
        await sessionData.browser.close();
      }
    }
    
    // Try to commit the partial run
    const run = await siteManager.commitPartialRun(domain);
    log.normal(`✓ Successfully committed run ${run.id} for ${domain} with ${run.items.length} URLs`);
    
    return { success: true, urls: collectedUrls };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error(`Failed to complete pagination for ${domain}: ${errorMsg}`);
    
    // Clean up browsers on error
    for (const sessionData of sessions) {
      if (sessionData.browser) {
        try {
          await sessionData.browser.close();
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
    
    return { success: false, urls: collectedUrls, error: errorMsg };
  }
}

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const sitesArg = args.find(arg => arg.startsWith('--sites='));
  const maxSessionsArg = args.find(arg => arg.startsWith('--max-sessions='));
  
  if (!sitesArg) {
    console.error('Usage: npm run example:robust-pagination -- --sites=site1.com,site2.com [--max-sessions=5]');
    process.exit(1);
  }
  
  const sites = sitesArg.replace('--sites=', '').split(',').map(s => s.trim());
  const maxSessions = maxSessionsArg ? parseInt(maxSessionsArg.replace('--max-sessions=', '')) : undefined;
  
  log.normal(`Will paginate ${sites.length} sites: ${sites.join(', ')}`);
  if (maxSessions) {
    log.normal(`Max sessions override: ${maxSessions}`);
  }
  
  // Initialize managers
  const siteManager = new SiteManager();
  const sessionManager = new SessionManager({ maxSessions: maxSessions || 10 });
  
  // Load sites from ETL API
  log.normal('Loading site configurations...');
  await siteManager.loadSites();
  
  // Process sites sequentially (could be parallel, but sequential is easier to debug)
  const results: Record<string, any> = {};
  
  for (const site of sites) {
    log.normal(`\n========== Processing ${site} ==========`);
    const result = await paginateSite(site, siteManager, sessionManager, maxSessions);
    results[site] = result;
    
    // Show blocked proxies after each site
    const blockedProxies = await siteManager.getBlockedProxies(site);
    if (blockedProxies.length > 0) {
      log.normal(`Blocked proxies for ${site}: ${blockedProxies.join(', ')}`);
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