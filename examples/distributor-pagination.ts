#!/usr/bin/env tsx --env-file=.env

/**
 * Distributor-based Multi-Site Pagination Example
 * 
 * Uses the double-pass distributor to paginate multiple sites efficiently
 * in a single round, respecting instance limits and per-site session limits.
 */

import { SessionManager } from '../src/services/session-manager.js';
import { SiteManager } from '../src/services/site-manager.js';
import { targetsToSessions } from '../src/core/distributor.js';
import { createBrowserFromSession } from '../src/drivers/browser.js';
import { loadScraper } from '../src/drivers/scraper-loader.js';
import { logger } from '../src/utils/logger.js';
import { urlsToScrapeTargets } from '../src/utils/scrape-target-utils.js';
import type { SessionInfo } from '../src/core/distributor.js';
import type { Session } from '../src/types/session.js';

const log = logger.createContext('distributor-pagination');

async function main() {
  // Parse command line args
  const args = process.argv.slice(2);
  let instanceLimit = 10; // Default
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--instance-limit' && i + 1 < args.length) {
      instanceLimit = parseInt(args[i + 1], 10);
      if (isNaN(instanceLimit) || instanceLimit < 1) {
        console.error('Invalid instance limit');
        process.exit(1);
      }
    }
  }
  
  log.normal(`Starting with instanceLimit: ${instanceLimit}`);
  
  const sessionManager = new SessionManager({ 
    sessionLimit: instanceLimit,
    provider: 'browserbase'
  });
  const siteManager = new SiteManager();
  
  try {
    // Load sites
    await siteManager.loadSites();
    
    // Get all startPages from sites (not marked as done)
    // Note: In a real implementation, you'd check scrape run status
    const allStartPages = siteManager.getAllStartPages();
    log.normal(`Found ${allStartPages.length} total startPages across all sites`);
    
    if (allStartPages.length === 0) {
      log.normal('No startPages found');
      return;
    }
    
    // Get site configs for distributor
    const siteConfigs = siteManager.getSiteConfigs();
    
    // Convert URLs to ScrapeTargets
    const allTargets = urlsToScrapeTargets(allStartPages.map(sp => sp.url));
    
    // First pass - distribute URLs to empty session list to see how many we need
    log.normal('\n=== First Pass: URL Distribution ===');
    const firstPassMatched = targetsToSessions(allTargets, [], siteConfigs);
    log.normal(`Matched ${firstPassMatched.length} URLs in first pass (no sessions yet)`);
    
    // Calculate how many sessions we need
    const sessionsNeeded = Math.min(instanceLimit, allTargets.length);
    log.normal(`\nWill create ${sessionsNeeded} sessions`);
    
    // Create sessions
    const sessions: Session[] = [];
    const sessionInfos: SessionInfo[] = [];
    
    for (let i = 0; i < sessionsNeeded; i++) {
      log.normal(`Creating session ${i + 1}/${sessionsNeeded}...`);
      const session = await sessionManager.createSession();
      sessions.push(session);
      
      // Create SessionInfo for distributor
      sessionInfos.push({
        id: session.browserbase?.id || `local-${i}`,
        proxyType: 'residential' as const
      });
      
      // Brief delay to avoid rate limits
      if (i < sessionsNeeded - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Second pass - distribute URLs to sessions
    log.normal('\n=== Second Pass: Session Assignment ===');
    const matched = targetsToSessions(allTargets, sessionInfos, siteConfigs);
    
    log.normal(`\nMatched ${matched.length} URL-session pairs`);
    log.normal('URL-Session assignments:');
    console.log('-'.repeat(80));
    
    matched.forEach((pair, index) => {
      const domain = new URL(pair.url).hostname;
      console.log(`${index + 1}. ${domain.padEnd(25)} | ${pair.url.substring(0, 50)}... | Session: ${pair.sessionId}`);
    });
    console.log('-'.repeat(80));
    
    // Now paginate all matched URLs concurrently
    log.normal('\n=== Starting Pagination ===');
    
    // Group by session for efficient processing
    const sessionGroups = new Map<string, typeof matched>();
    matched.forEach(pair => {
      const sessionId = pair.sessionId;
      if (!sessionGroups.has(sessionId)) {
        sessionGroups.set(sessionId, []);
      }
      sessionGroups.get(sessionId)!.push(pair);
    });
    
    // Process each session's URLs
    const paginationTasks = Array.from(sessionGroups.entries()).map(async ([sessionId, pairs]) => {
      // Find the actual session object
      const session = sessions.find(s => 
        (s.browserbase?.id || `local-${sessions.indexOf(s)}`) === sessionId
      );
      
      if (!session) {
        log.error(`Session ${sessionId} not found`);
        return;
      }
      
      const { browser, createContext } = await createBrowserFromSession(session);
      const context = await createContext();
      
      // Process each URL for this session
      for (const pair of pairs) {
        const domain = new URL(pair.url).hostname.replace('www.', '');
        
        try {
          log.normal(`[${sessionId}] Starting pagination for ${domain}`);
          
          const page = await context.newPage();
          const scraper = await loadScraper(domain);
          
          // Navigate to start page
          await page.goto(pair.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          
          let pageCount = 1;
          const allUrls = new Set<string>();
          
          // Get URLs from first page
          const firstPageUrls = await scraper.getItemUrls(page);
          firstPageUrls.forEach(url => allUrls.add(url));
          
          // Do ONE round of pagination
          const hasMore = await scraper.paginate(page);
          if (hasMore) {
            pageCount++;
            const secondPageUrls = await scraper.getItemUrls(page);
            secondPageUrls.forEach(url => allUrls.add(url));
            log.normal(`[${sessionId}] ${domain}: Got ${allUrls.size} URLs from ${pageCount} pages`);
          } else {
            log.normal(`[${sessionId}] ${domain}: Got ${allUrls.size} URLs from 1 page (no more pages)`);
          }
          
          await page.close();
          
        } catch (error) {
          log.error(`[${sessionId}] Error paginating ${domain}: ${error.message}`);
        }
      }
      
      await context.close();
      await browser.close();
    });
    
    // Wait for all pagination to complete
    await Promise.all(paginationTasks);
    
    log.normal('\n=== Pagination Complete ===');
    
    // Clean up all sessions
    log.normal('\nCleaning up sessions...');
    await sessionManager.destroyAllSessions();
    log.normal('Done!');
    
  } catch (error) {
    log.error('Error:', error);
    await sessionManager.destroyAllSessions();
    process.exit(1);
  }
}

main();