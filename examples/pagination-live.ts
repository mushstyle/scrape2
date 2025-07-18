/**
 * Live example: Pagination using double-pass matcher pattern
 * 
 * This example demonstrates production-ready pagination using:
 * - Double-pass matcher algorithm (use existing sessions first)
 * - Smart session creation based on URL requirements
 * - Proper URL deduplication within and across pages
 * - Distributor for intelligent URL-session matching
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
import type { ScrapeTarget } from '../src/types/scrape-target.js';
import type { Page } from 'playwright';

const log = logger.createContext('pagination-live');

interface SessionWithBrowser {
  session: Session;
  sessionInfo: SessionInfo;
  browser?: any;
  context?: any;
  inUse?: boolean;
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
  const sessionManager = new SessionManager();
  
  // Load sites from ETL API
  log.normal('Loading site configurations...');
  await siteManager.loadSites();
  
  // Step 1: Collect all start page URLs from all sites
  const allTargets: ScrapeTarget[] = [];
  const urlToSite = new Map<string, string>();
  
  for (const site of sites) {
    const siteConfig = siteManager.getSite(site);
    if (!siteConfig?.config.startPages?.length) {
      log.error(`No start pages for ${site}, skipping`);
      continue;
    }
    
    // Start pagination tracking
    await siteManager.startPagination(site, siteConfig.config.startPages);
    
    // Convert to targets and track which site each URL belongs to
    const targets = urlsToScrapeTargets(siteConfig.config.startPages);
    for (const target of targets) {
      // Deduplicate URLs across sites
      if (!urlToSite.has(target.url)) {
        allTargets.push(target);
        urlToSite.set(target.url, site);
      } else {
        log.debug(`Skipping duplicate URL ${target.url} (already assigned to ${urlToSite.get(target.url)})`);
      }
    }
  }
  
  log.normal(`\nCollected ${allTargets.length} unique start page URLs across all sites`);
  
  // Step 2: Get existing sessions
  const existingSessions = await sessionManager.getActiveSessions();
  const sessionDataMap = new Map<string, SessionWithBrowser>();
  
  // Convert existing sessions to SessionWithBrowser format
  const existingSessionData: SessionWithBrowser[] = existingSessions.map((session, i) => {
    const sessionInfo: SessionInfo = {
      id: `existing-${i}`,
      proxyType: session.proxy?.type as any || 'none',
      proxyId: session.proxy?.id,
      proxyGeo: session.proxy?.geo
    };
    const data = { session, sessionInfo };
    sessionDataMap.set(sessionInfo.id, data);
    return data;
  });
  
  log.normal(`Found ${existingSessionData.length} existing sessions`);
  
  // Step 3: First pass - match with existing sessions
  const siteConfigs = await siteManager.getSiteConfigsWithBlockedProxies();
  
  // Filter site configs to only include the sites we're processing
  const relevantSiteConfigs = siteConfigs.filter(config => sites.includes(config.domain));
  
  // Limit targets to instance limit
  const targetsToProcess = allTargets.slice(0, instanceLimit);
  
  log.debug(`Processing ${targetsToProcess.length} targets with ${existingSessionData.length} sessions`);
  log.debug(`Site configs: ${relevantSiteConfigs.length} (filtered from ${siteConfigs.length} total)`);
  
  const firstPassPairs = targetsToSessions(
    targetsToProcess,
    existingSessionData.map(s => s.sessionInfo),
    relevantSiteConfigs
  );
  
  log.normal(`First pass: Matched ${firstPassPairs.length} URLs to existing sessions`);
  
  // Mark used sessions
  firstPassPairs.forEach(pair => {
    const session = sessionDataMap.get(pair.sessionId);
    if (session) session.inUse = true;
  });
  
  // Step 4: Terminate excess sessions
  const excessSessions = existingSessionData.filter(s => !s.inUse);
  if (excessSessions.length > 0) {
    log.normal(`Terminating ${excessSessions.length} excess sessions`);
    await Promise.all(excessSessions.map(s => sessionManager.destroySession(s.session.id)));
  }
  
  // Step 5: Calculate how many new sessions we need
  const sessionsNeeded = Math.min(instanceLimit - firstPassPairs.length, targetsToProcess.length - firstPassPairs.length);
  
  if (sessionsNeeded > 0) {
    log.normal(`\nNeed to create ${sessionsNeeded} new sessions`);
    
    // Analyze unmatched URLs to determine proxy requirements
    const unmatchedTargets = targetsToProcess.filter(
      target => !firstPassPairs.find(pair => pair.url === target.url)
    );
    
    // Group by domain to understand proxy needs
    const domainCounts = new Map<string, number>();
    unmatchedTargets.slice(0, sessionsNeeded).forEach(target => {
      const domain = urlToSite.get(target.url) || new URL(target.url).hostname;
      domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    });
    
    log.normal('Proxy requirements for new sessions:');
    for (const [domain, count] of domainCounts) {
      const proxy = await siteManager.getProxyForDomain(domain);
      log.normal(`  ${domain}: ${count} sessions (${proxy?.type || 'no proxy'})`);
    }
    
    // Create sessions based on requirements
    const newSessionRequests: Array<{domain: string, proxy: any}> = [];
    for (const [domain, count] of domainCounts) {
      for (let i = 0; i < count; i++) {
        const proxy = await siteManager.getProxyForDomain(domain);
        newSessionRequests.push({ domain, proxy });
      }
    }
    
    const newSessions = await Promise.all(
      newSessionRequests.map(req => sessionManager.createSession(req))
    ) as Session[];
    log.normal(`Created ${newSessions.length} new sessions`);
    
    // Add new sessions to our tracking
    newSessions.forEach((session, i) => {
      // Get the proxy from the original request since session might not have it
      const originalRequest = newSessionRequests[i];
      const sessionInfo: SessionInfo = {
        id: `new-${i}`,
        proxyType: originalRequest.proxy?.type as any || 'none',
        proxyId: originalRequest.proxy?.id,
        proxyGeo: originalRequest.proxy?.geo
      };
      const data = { session, sessionInfo };
      sessionDataMap.set(sessionInfo.id, data);
      existingSessionData.push(data);
    });
    
    // Step 6: Second pass with all sessions
    log.debug(`Second pass: ${targetsToProcess.length} targets, ${existingSessionData.length} sessions`);
    
    const secondPassPairs = targetsToSessions(
      targetsToProcess,
      existingSessionData.map(s => s.sessionInfo),
      relevantSiteConfigs
    );
    
    log.normal(`Second pass: Matched ${secondPassPairs.length} URLs total (limit: ${instanceLimit})`);
    
    // Use second pass results
    await processUrlSessionPairs(secondPassPairs, sessionDataMap, urlToSite, siteManager);
  } else {
    // Use first pass results only
    await processUrlSessionPairs(firstPassPairs, sessionDataMap, urlToSite, siteManager);
  }
  
  // Clean up all browsers
  for (const sessionData of sessionDataMap.values()) {
    if (sessionData.browser) {
      try {
        await sessionData.context?.close();
        await sessionData.browser.close();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
  
  // Show results
  log.normal('\n========== SUMMARY ==========');
  const processedSites = new Set(Array.from(urlToSite.values()));
  
  for (const site of processedSites) {
    // Check partial runs for uncommitted data
    const uncommittedSites = siteManager.getSitesWithPartialRuns();
    const hasUncommitted = uncommittedSites.includes(site);
    
    if (hasUncommitted) {
      log.normal(`⚠️  ${site}: Has uncommitted partial run data`);
    } else {
      // Success case - partial run was committed
      log.normal(`✓ ${site}: Successfully processed and committed`);
    }
  }
  
  // Show any sites not in the processedSites set but requested
  for (const site of sites) {
    if (!processedSites.has(site)) {
      log.normal(`✗ ${site}: No start pages found or skipped`);
    }
  }
}

async function processUrlSessionPairs(
  pairs: Array<{ url: string; sessionId: string }>,
  sessionDataMap: Map<string, SessionWithBrowser>,
  urlToSite: Map<string, string>,
  siteManager: SiteManager
) {
  const log = logger.createContext('process-pairs');
  
  // Create browsers only for sessions that will be used
  const usedSessionIds = new Set(pairs.map(p => p.sessionId));
  log.normal(`Creating browsers for ${usedSessionIds.size} sessions that will be used`);
  
  await Promise.all(
    Array.from(usedSessionIds).map(async sessionId => {
      const sessionData = sessionDataMap.get(sessionId);
      if (sessionData && !sessionData.browser) {
        const { browser, createContext } = await createBrowserFromSession(sessionData.session);
        sessionData.browser = browser;
        sessionData.context = await createContext();
      }
    })
  );
  
  // Process each URL-session pair
  await Promise.all(pairs.map(async (pair) => {
    const sessionData = sessionDataMap.get(pair.sessionId);
    const site = urlToSite.get(pair.url);
    
    if (!sessionData?.browser || !site) {
      log.error(`Missing session or site for ${pair.url}`);
      return;
    }
    
    try {
      const scraper = await loadScraper(site);
      const page: Page = await sessionData.context.newPage();
      
      try {
        await page.goto(pair.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        const uniqueUrls = new Set<string>();
        let currentPage = 1;
        const maxPages = 5;
        
        // Collect from first page
        const firstPageUrls = await scraper.getItemUrls(page);
        firstPageUrls.forEach(url => uniqueUrls.add(url));
        log.normal(`[${site}] ${pair.url} page 1: ${firstPageUrls.size} items (${uniqueUrls.size} unique total)`);
        
        // Paginate
        while (currentPage < maxPages) {
          const hasMore = await scraper.paginate(page);
          if (!hasMore) break;
          
          currentPage++;
          const beforeCount = uniqueUrls.size;
          const urls = await scraper.getItemUrls(page);
          urls.forEach(url => uniqueUrls.add(url));
          const newItems = uniqueUrls.size - beforeCount;
          log.normal(`[${site}] ${pair.url} page ${currentPage}: ${urls.size} items (${newItems} new, ${uniqueUrls.size} unique total)`);
        }
        
        // Convert Set to Array for pagination state
        const pageUrls = Array.from(uniqueUrls);
        
        // Update pagination state
        siteManager.updatePaginationState(pair.url, {
          collectedUrls: pageUrls,
          completed: true
        });
        
        log.normal(`[${site}] Collected ${pageUrls.length} unique URLs from ${pair.url}`);
        
      } finally {
        await page.close();
      }
    } catch (error) {
      log.error(`Failed to process ${pair.url}: ${error.message}`);
      siteManager.updatePaginationState(pair.url, {
        collectedUrls: [],
        completed: true,
        failureCount: 1
      });
    }
  }));
  
  // Commit partial runs for each site
  const processedSites = new Set(Array.from(urlToSite.values()));
  for (const site of processedSites) {
    try {
      const run = await siteManager.commitPartialRun(site);
      log.normal(`✓ Committed run ${run.id} for ${site}`);
    } catch (error) {
      log.error(`Failed to commit run for ${site}: ${error.message}`);
    }
  }
}

// Run the example
main().catch(error => {
  log.error('Example failed:', error);
  process.exit(1);
});