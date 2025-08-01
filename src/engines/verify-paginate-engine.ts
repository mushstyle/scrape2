/**
 * VerifyPaginateEngine
 * 
 * Core engine for verifying pagination functionality using the distributor.
 * Uses the distributor for URL-session matching and properly handles pagination.
 */

import { SessionManager } from '../services/session-manager.js';
import { SiteManager } from '../services/site-manager.js';
import { createBrowserFromSession } from '../drivers/browser.js';
import { logger } from '../utils/logger.js';
import { loadScraper } from '../drivers/scraper-loader.js';
import { targetsToSessions } from '../core/distributor.js';
import { urlsToScrapeTargets } from '../utils/scrape-target-utils.js';
import { RequestCache } from '../drivers/cache.js';
import type { Session } from '../types/session.js';
import type { SessionInfo } from '../core/distributor.js';
import type { ScrapeTarget } from '../types/scrape-target.js';
import type { Page, Browser, BrowserContext } from 'playwright';

const log = logger.createContext('verify-paginate-engine');

interface SessionWithBrowser {
  session: Session;
  sessionInfo: SessionInfo;
  browser?: Browser;
  context?: BrowserContext;
}

export interface VerifyPaginateOptions {
  domain: string;
  specificUrl?: string;  // Optional: test only this specific URL
  maxIterations?: number;
  maxPages?: number;
  useSingleSession?: boolean;
  localHeadless?: boolean;  // Use local browser in headless mode
  localHeaded?: boolean;    // Use local browser in headed mode
  sessionTimeout?: number;  // Session timeout in seconds
  sessionManager?: SessionManager;
  siteManager?: SiteManager;
  noProxy?: boolean;  // Disable proxy usage regardless of site configuration
}

export interface VerifyPaginateResult {
  success: boolean;
  domain: string;
  startPagesCount: number;
  totalPagesScraped: number;
  totalUniqueUrls: number;
  errors: string[];
  duration: number;
  iterations: number;
}

export class VerifyPaginateEngine {
  private sessionManager: SessionManager;
  private siteManager: SiteManager;
  
  constructor(options: Partial<VerifyPaginateOptions> = {}) {
    // Create SessionManager with appropriate provider based on options
    if (!options.sessionManager) {
      const provider = (options.localHeadless || options.localHeaded) ? 'local' : 'browserbase';
      this.sessionManager = new SessionManager({ provider });
    } else {
      this.sessionManager = options.sessionManager;
    }
    this.siteManager = options.siteManager || new SiteManager();
  }
  
  async verify(options: VerifyPaginateOptions): Promise<VerifyPaginateResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const allUrls = new Set<string>();
    const sessions: SessionWithBrowser[] = [];
    let totalPagesScraped = 0;
    let iterations = 0;
    
    try {
      // Initialize
      await this.siteManager.loadSites();
      const siteConfig = this.siteManager.getSiteConfig(options.domain);
      if (!siteConfig) {
        throw new Error(`No site config for ${options.domain}`);
      }
      
      // Use specific URL if provided, otherwise use all start pages
      const startPages = options.specificUrl 
        ? [options.specificUrl] 
        : siteConfig.startPages || [];
      
      if (!startPages.length) {
        throw new Error(`No start pages configured for ${options.domain}`);
      }
      
      // Load scraper
      const scraper = await loadScraper(options.domain);
      log.normal(`Loaded scraper for ${options.domain}`);
      
      // Get session limit and create sessions
      const sessionLimit = await this.siteManager.getSessionLimitForDomain(options.domain);
      const sessionsToCreate = Math.min(sessionLimit, startPages.length);
      
      log.normal(`Site: ${options.domain}`);
      if (options.specificUrl) {
        log.normal(`Testing specific URL: ${options.specificUrl}`);
      } else {
        log.normal(`Start pages: ${startPages.length}`);
      }
      log.normal(`Session limit: ${sessionLimit}`);
      log.normal(`Creating ${sessionsToCreate} sessions`);
      
      // Get proxy for domain once
      const proxy = options.noProxy ? null : await this.siteManager.getProxyForDomain(options.domain);
      
      // Create all session requests
      const sessionRequests = Array(sessionsToCreate).fill(null).map(() => ({
        domain: options.domain,
        proxy,
        headless: options.localHeadless ? true : (options.localHeaded ? false : true), // default to headless
        timeout: options.sessionTimeout
      }));
      
      // Create all sessions in parallel (SessionManager handles this efficiently)
      const createdSessions = await this.sessionManager.createSession(sessionRequests) as Session[];
      
      // Add successfully created sessions with their info
      createdSessions.forEach((session, i) => {
        const sessionInfo: SessionInfo = {
          id: `session-${i}`,
          proxyType: proxy?.type as any || 'none',
          proxyId: proxy?.id,
          proxyGeo: proxy?.geo
        };
        
        sessions.push({ session, sessionInfo });
      });
      
      if (createdSessions.length < sessionsToCreate) {
        log.normal(`Only created ${createdSessions.length}/${sessionsToCreate} sessions`);
      }
      
      // Start with initial URLs as ScrapeTargets
      const targets = urlsToScrapeTargets(startPages);
      const maxPages = options.maxPages || Infinity;  // NO LIMIT by default!
      
      // Use distributor to match URLs to sessions
      const pairs = targetsToSessions(
        targets,
        sessions.map(s => s.sessionInfo),
        [siteConfig]
      );
      
      log.normal(`\nDistributor created ${pairs.length} URL-session pairs`);
      
      // If useSingleSession is true, only use the first pair
      const pairsToProcess = options.useSingleSession ? pairs.slice(0, 1) : pairs;
      if (options.useSingleSession) {
        log.normal(`Using single session mode - processing only first URL`);
      }
      
      // Process each pair - navigate once, then paginate on same page
      await Promise.all(pairsToProcess.map(async (pair) => {
        const sessionData = sessions.find(s => s.sessionInfo.id === pair.sessionId);
        if (!sessionData) {
          errors.push(`Session ${pair.sessionId} not found`);
          return;
        }
        
        try {
          // Create browser/context if needed
          if (!sessionData.browser) {
            const { browser, createContext } = await createBrowserFromSession(sessionData.session);
            sessionData.browser = browser;
            sessionData.context = await createContext();
          }
          
          // Create page and navigate ONCE
          const page = await sessionData.context!.newPage();
          
          // Enable caching with image blocking for bandwidth savings
          const cache = new RequestCache({
            maxSizeBytes: 100 * 1024 * 1024, // 100MB for pagination verification
            blockImages: true  // Block images by default
          });
          await cache.enableForPage(page);
          
          log.normal(`Navigating to ${pair.url}`);
          await page.goto(pair.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          
          let pageCount = 0;
          let hasMore = true;
          
          // Pagination loop on the SAME page object
          while (hasMore && pageCount < maxPages) {
            pageCount++;
            iterations++;
            
            // Get item URLs from current page state
            const urls = await scraper.getItemUrls(page);
            log.normal(`Page ${pageCount}: Found ${urls.size} items`);
            urls.forEach(url => allUrls.add(url));
            totalPagesScraped++;
            
            // Try to go to next page (scraper handles navigation internally)
            if (pageCount < maxPages) {
              hasMore = await scraper.paginate(page);
              if (!hasMore) {
                log.normal(`No more pages for ${pair.url} (scraped ${pageCount} pages)`);
              }
            }
          }
          
          await page.close();
        } catch (error) {
          const errorMsg = `Error processing ${pair.url}: ${error.message}`;
          log.error(errorMsg);
          errors.push(errorMsg);
        }
      }));
      
      // Compile results
      const result: VerifyPaginateResult = {
        success: errors.length === 0,
        domain: options.domain,
        startPagesCount: startPages.length,
        totalPagesScraped,
        totalUniqueUrls: allUrls.size,
        errors,
        duration: Date.now() - startTime,
        iterations
      };
      
      // Cleanup
      log.normal('\nCleaning up...');
      await this.cleanup(sessions);
      
      return result;
      
    } catch (error) {
      log.error(`Fatal error: ${error.message}`);
      errors.push(`Fatal: ${error.message}`);
      
      // Cleanup on error
      await this.cleanup(sessions);
      
      return {
        success: false,
        domain: options.domain,
        startPagesCount: 0,
        totalPagesScraped,
        totalUniqueUrls: allUrls.size,
        errors,
        duration: Date.now() - startTime,
        iterations
      };
    }
  }
  
  private async cleanup(sessions: SessionWithBrowser[]): Promise<void> {
    // Close all browsers
    await Promise.all(sessions.map(async (s) => {
      if (s.context) {
        await s.context.close().catch(e => log.debug(`Failed to close context: ${e.message}`));
      }
      if (s.browser) {
        await s.browser.close().catch(e => log.debug(`Failed to close browser: ${e.message}`));
      }
    }));
    
    // Destroy all sessions
    await this.sessionManager.destroyAllSessions();
  }
}