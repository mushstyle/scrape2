import { logger } from '../utils/logger.js';
import { SiteManager } from '../services/site-manager.js';
import { SessionManager } from '../services/session-manager.js';
import { targetsToSessions } from '../core/distributor.js';
import { loadScraper } from '../drivers/scraper-loader.js';
import { createBrowserFromSession } from '../drivers/browser.js';
import { urlsToScrapeTargets } from '../utils/scrape-target-utils.js';
import { RequestCache } from '../drivers/cache.js';
import type { Session } from '../types/session.js';
import type { SessionInfo } from '../core/distributor.js';
import type { ScrapeTarget } from '../types/scrape-target.js';
import type { Page } from 'playwright';

const log = logger.createContext('paginate-engine');

export interface PaginateOptions {
  sites?: string[];  // If not specified, paginate all sites with scraping enabled
  exclude?: string[];  // Sites to exclude (takes precedence over sites)
  since?: Date;  // Only paginate sites without runs since this date
  force?: boolean;  // Force pagination even if sites have recent runs (ignores since)
  instanceLimit?: number;  // Default: 10
  maxPages?: number;  // Default: 5
  disableCache?: boolean;  // Cache ON by default
  cacheSizeMB?: number;  // Default: 250
  cacheTTLSeconds?: number;  // Default: 300 (5 minutes)
  noSave?: boolean;  // Save to DB by default
  localHeadless?: boolean;  // Use local browser in headless mode
  localHeaded?: boolean;  // Use local browser in headed mode
  sessionTimeout?: number;  // Session timeout in seconds (browserbase only)
  maxRetries?: number;  // Default: 2 (for network errors)
}

export interface PaginateResult {
  success: boolean;
  sitesProcessed: number;
  totalUrls: number;
  urlsBySite: Map<string, string[]>;
  errors: Map<string, string>;
  duration: number;
  cacheStats?: CacheStats;
}

interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  totalSizeMB: number;
}

interface SessionWithBrowser {
  session: Session;
  sessionInfo: SessionInfo;
  browser?: any;
  context?: any;
  inUse?: boolean;
  cache?: RequestCache;
}

export class PaginateEngine {
  private sessionDataMap = new Map<string, SessionWithBrowser>();
  private globalCache: RequestCache | null = null;
  
  constructor(
    private siteManager: SiteManager,
    private sessionManager: SessionManager
  ) {}

  async paginate(options: PaginateOptions): Promise<PaginateResult> {
    const startTime = Date.now();
    const errors = new Map<string, string>();
    const urlsBySite = new Map<string, string[]>();
    
    // Set defaults
    const instanceLimit = options.instanceLimit || 10;
    const maxPages = options.maxPages || Infinity;  // NO LIMIT by default!
    const cacheSizeMB = options.cacheSizeMB || 250;
    const cacheTTLSeconds = options.cacheTTLSeconds || 300;
    const maxRetries = options.maxRetries || 2;
    
    try {
      // Step 1: Get sites to process
      const sitesToProcess = await this.getSitesToProcess(options.sites, options.since, options.force, options.exclude);
      log.normal(`Will paginate ${sitesToProcess.length} sites`);
      
      if (sitesToProcess.length === 0) {
        return {
          success: true,
          sitesProcessed: 0,
          totalUrls: 0,
          urlsBySite,
          errors,
          duration: Date.now() - startTime
        };
      }
      
      // Step 2: Start pagination tracking for all sites
      const siteStartPages = new Map<string, string[]>();
      for (const site of sitesToProcess) {
        const allStartPages = await this.siteManager.getStartPagesForDomain(site);
        if (allStartPages.length > 0) {
          siteStartPages.set(site, allStartPages);
          await this.siteManager.startPagination(site, allStartPages);
        }
      }
      log.normal(`Started pagination tracking for ${siteStartPages.size} sites`);
      
      // Process in batches, getting unprocessed URLs each time
      const processedUrls = new Set<string>();
      let batchNumber = 1;
      let cacheStats: CacheStats | undefined;
      
      while (true) {
        // Get unprocessed start pages respecting session limits
        const unprocessedStartPages = await this.siteManager.getUnprocessedStartPagesWithLimits(sitesToProcess);
        if (unprocessedStartPages.length === 0) {
          log.normal('All start pages have been processed');
          break;
        }
        
        // Convert to targets and create URL to site mapping
        const allTargets = urlsToScrapeTargets(unprocessedStartPages.map(sp => sp.url));
        const urlToSite = new Map<string, string>();
        unprocessedStartPages.forEach(sp => urlToSite.set(sp.url, sp.domain));
        
        log.normal(`Collected ${allTargets.length} unprocessed start page URLs across all sites`);
        // Get unprocessed targets for this batch
        const remainingTargets = allTargets.filter(t => !processedUrls.has(t.url));
        if (remainingTargets.length === 0) break;
        
        const targetsToProcess = remainingTargets.slice(0, instanceLimit);
        
        log.normal(`\nBatch ${batchNumber}: Processing up to ${targetsToProcess.length} URLs (${processedUrls.size} already processed, ${allTargets.length} total)`);
        
        // Get existing sessions
        const existingSessions = await this.sessionManager.getActiveSessions();
        
        // Reset inUse flags for all sessions at start of each batch
        for (const sessionData of this.sessionDataMap.values()) {
          sessionData.inUse = false;
        }
        
        // Convert existing sessions to SessionWithBrowser format (updates class sessionDataMap)
        const existingSessionData = this.convertSessionsToSessionData(existingSessions, this.sessionDataMap);
        log.normal(`Found ${existingSessionData.length} existing sessions`);
        
        // Get site configs with blocked proxies
        const siteConfigs = await this.siteManager.getSiteConfigsWithBlockedProxies();
        const relevantSiteConfigs = siteConfigs.filter(config => 
          sitesToProcess.includes(config.domain)
        );
        
        // First pass - match with existing sessions
        const firstPassPairs = targetsToSessions(
          targetsToProcess,
          existingSessionData.map(s => s.sessionInfo),
          relevantSiteConfigs
        );
        
        log.normal(`First pass: Matched ${firstPassPairs.length} URLs to existing sessions`);
        
        // Mark used sessions
        firstPassPairs.forEach(pair => {
          const session = this.sessionDataMap.get(pair.sessionId);
          if (session) session.inUse = true;
        });
        
        // Terminate excess sessions
        const excessSessions = existingSessionData.filter(s => !s.inUse);
        if (excessSessions.length > 0) {
          log.normal(`Terminating ${excessSessions.length} excess sessions`);
          await Promise.all(excessSessions.map(s => 
            this.sessionManager.destroySessionByObject(s.session)
          ));
        }
        
        // Calculate how many new sessions we need
        const sessionsNeeded = Math.min(
          instanceLimit - firstPassPairs.length, 
          targetsToProcess.length - firstPassPairs.length
        );
        
        let finalPairs = firstPassPairs;
        
        if (sessionsNeeded > 0) {
          // Create new sessions and do second pass
          await this.createNewSessions(
            sessionsNeeded, 
            targetsToProcess, 
            firstPassPairs, 
            urlToSite, 
            this.sessionDataMap, 
            existingSessionData,
            options
          );
          
          // Second pass with all sessions
          finalPairs = targetsToSessions(
            targetsToProcess,
            existingSessionData.map(s => s.sessionInfo),
            relevantSiteConfigs
          );
          
          log.normal(`Second pass: Matched ${finalPairs.length} URLs total (limit: ${instanceLimit})`);
        }
        
        // Process URL-session pairs
        const batchCacheStats = await this.processUrlSessionPairs(
          finalPairs,
          this.sessionDataMap,
          urlToSite,
          maxPages,
          maxRetries,
          options.disableCache ? undefined : { cacheSizeMB, cacheTTLSeconds }
        );
        
        
        // Merge cache stats
        if (batchCacheStats) {
          if (!cacheStats) {
            cacheStats = batchCacheStats;
          } else {
            cacheStats.hits += batchCacheStats.hits;
            cacheStats.misses += batchCacheStats.misses;
            cacheStats.totalSizeMB = Math.max(cacheStats.totalSizeMB, batchCacheStats.totalSizeMB);
            cacheStats.hitRate = (cacheStats.hits * 100) / (cacheStats.hits + cacheStats.misses);
          }
        }
        
        // Do NOT clean up browsers between batches - we want to reuse them!
        
        // Commit any completed runs after this batch if not noSave
        if (!options.noSave) {
          // Simply check ALL sites with partial runs, not just the ones we think we processed
          const allSitesWithPartialRuns = await this.siteManager.getSitesWithPartialRuns();
          const completedSites = new Set<string>();
          
          for (const site of allSitesWithPartialRuns) {
            const partialRun = this.getPartialRunForSite(site);
            if (partialRun && !partialRun.committedToDb) {
              // Check if all pagination states for this site are completed
              const allStatesCompleted = Array.from(partialRun.paginationStates.values())
                .every(state => state.completed);
              // Also check that at least one state has collected URLs
              const hasAnyUrls = Array.from(partialRun.paginationStates.values())
                .some(state => state.collectedUrls.length > 0);
              
              if (allStatesCompleted && hasAnyUrls) {
                completedSites.add(site);
              }
            }
          }
          
          if (completedSites.size > 0) {
            log.normal(`Committing ${completedSites.size} completed runs after batch ${batchNumber}`);
            await this.commitPartialRuns(completedSites, errors);
          }
        }
        
        // Mark URLs as processed based on what was actually matched
        for (const pair of finalPairs) {
          processedUrls.add(pair.url);
        }
        batchNumber++;
      }
      
      // Step 9: Collect results BEFORE committing (while partial runs still exist)
      for (const site of sitesToProcess) {
        const siteData = this.siteManager.getSite(site);
        if (siteData) {
          const urls: string[] = [];
          // Get URLs from partial runs
          const partialRun = this.getPartialRunForSite(site);
          if (partialRun) {
            for (const state of partialRun.paginationStates.values()) {
              urls.push(...state.collectedUrls);
            }
          }
          if (urls.length > 0) {
            urlsBySite.set(site, urls);
          }
        }
      }
      
      // Step 10: Commit any remaining partial runs if not noSave
      if (!options.noSave) {
        const remainingSites = await this.siteManager.getSitesWithPartialRuns();
        const uncommittedSites = [];
        
        for (const site of remainingSites) {
          const partialRun = this.getPartialRunForSite(site);
          if (partialRun && !partialRun.committedToDb) {
            uncommittedSites.push(site);
          }
        }
        
        if (uncommittedSites.length > 0) {
          log.normal(`Committing ${uncommittedSites.length} remaining runs`);
          await this.commitPartialRuns(new Set(uncommittedSites), errors);
        }
      }
      
      const totalUrls = Array.from(urlsBySite.values()).reduce((sum, urls) => sum + urls.length, 0);
      
      return {
        success: errors.size === 0,
        sitesProcessed: urlsBySite.size,
        totalUrls,
        urlsBySite,
        errors,
        duration: Date.now() - startTime,
        cacheStats
      };
      
    } catch (error) {
      log.error('Pagination failed:', error);
      throw error;
    } finally {
      // Clean up all sessions at the very end
      log.debug('Cleaning up all sessions');
      await this.sessionManager.destroyAllSessions();
      this.sessionDataMap.clear();
      this.globalCache = null;
    }
  }
  
  private async getSitesToProcess(sites?: string[], since?: Date, force?: boolean, exclude?: string[]): Promise<string[]> {
    let sitesToProcess: string[];
    
    log.debug('getSitesToProcess called with:', { sites, since, force, exclude });
    
    if (sites && sites.length > 0) {
      sitesToProcess = sites;
      log.debug('Using provided sites:', sitesToProcess);
    } else {
      // Get all sites with scraping enabled
      const allSites = this.siteManager.getSitesWithStartPages();
      sitesToProcess = allSites.map(site => site.domain);
      log.debug('Using all sites with start pages:', sitesToProcess.length);
    }
    
    // Apply exclude filter first (takes precedence)
    if (exclude && exclude.length > 0) {
      const excludeSet = new Set(exclude);
      sitesToProcess = sitesToProcess.filter(site => !excludeSet.has(site));
      log.normal(`Excluded ${exclude.length} sites: ${exclude.join(', ')}`);
    }
    
    // If force is true, skip the since filtering
    if (force) {
      log.normal('Force flag enabled - processing all sites regardless of recent runs');
      return sitesToProcess;
    }
    
    // If since is specified, filter out sites that have ANY runs created after the date
    if (since) {
      const sitesWithRecentRuns = new Set<string>();
      
      // For each site we want to process, check if it has ANY runs created after the date
      for (const site of sitesToProcess) {
        const recentRuns = await this.siteManager.listRuns({ 
          domain: site,
          since 
        });
        if (recentRuns.runs.length > 0) {
          sitesWithRecentRuns.add(site);
        }
      }
      
      // Filter out sites that have ANY runs created recently
      const filteredSites = sitesToProcess.filter(site => !sitesWithRecentRuns.has(site));
      
      log.normal(`Since ${since.toISOString()}: ${sitesWithRecentRuns.size} sites have recent runs, ${filteredSites.length} sites need pagination`);
      
      return filteredSites;
    }
    
    return sitesToProcess;
  }
  
  
  private convertSessionsToSessionData(
    sessions: Session[],
    sessionDataMap: Map<string, SessionWithBrowser>
  ): SessionWithBrowser[] {
    return sessions.map((session) => {
      // Use the actual session ID so it can be matched across batches
      const sessionId = this.getSessionId(session);
      
      // For browserbase sessions, proxy info is in session.browserbase, not session.local!
      const proxyInfo = session.provider === 'browserbase' ? session.browserbase?.proxy : session.local?.proxy;
      
      const sessionInfo: SessionInfo = {
        id: sessionId,
        proxyType: proxyInfo?.type as any || 'none',
        proxyId: proxyInfo?.id,
        proxyGeo: proxyInfo?.geo
      };
      const data = { session, sessionInfo };
      sessionDataMap.set(sessionInfo.id, data);
      return data;
    });
  }
  
  private getSessionId(session: Session): string {
    if (session.provider === 'browserbase') {
      return session.browserbase!.id;
    } else {
      // For local sessions, generate a stable ID
      return `local-${session.local?.id || 'unknown'}`;
    }
  }
  
  private async createNewSessions(
    sessionsNeeded: number,
    targetsToProcess: ScrapeTarget[],
    firstPassPairs: Array<{ url: string; sessionId: string }>,
    urlToSite: Map<string, string>,
    sessionDataMap: Map<string, SessionWithBrowser>,
    existingSessionData: SessionWithBrowser[],
    options: PaginateOptions
  ): Promise<void> {
    log.normal(`Need to create ${sessionsNeeded} new sessions`);
    
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
      const proxy = await this.siteManager.getProxyForDomain(domain);
      log.normal(`  ${domain}: ${count} sessions (${proxy?.type || 'no proxy'})`);
    }
    
    // Create sessions based on requirements
    const newSessionRequests: Array<{domain: string, proxy: any, browserType?: string, headless?: boolean, timeout?: number}> = [];
    for (const [domain, count] of domainCounts) {
      for (let i = 0; i < count; i++) {
        const proxy = await this.siteManager.getProxyForDomain(domain);
        const request: any = { domain, proxy };
        
        // Add browser type if local browser requested
        if (options.localHeadless || options.localHeaded) {
          request.browserType = 'local';
          request.headless = !options.localHeaded; // headed means headless=false
        }
        
        // Add timeout if specified
        if (options.sessionTimeout) {
          request.timeout = options.sessionTimeout;
        }
        
        newSessionRequests.push(request);
      }
    }
    
    // Pass all requests as an array to avoid race condition in session limit check
    const newSessions = await this.sessionManager.createSession(newSessionRequests) as Session[];
    log.normal(`Created ${newSessions.length} new sessions`);
    
    // Add new sessions to our tracking
    newSessions.forEach((session, i) => {
      const originalRequest = newSessionRequests[i];
      // Use the actual session ID so it can be matched across batches
      const sessionId = this.getSessionId(session);
      const sessionInfo: SessionInfo = {
        id: sessionId,
        proxyType: originalRequest.proxy?.type as any || 'none',
        proxyId: originalRequest.proxy?.id,
        proxyGeo: originalRequest.proxy?.geo
      };
      const data = { session, sessionInfo };
      sessionDataMap.set(sessionInfo.id, data);
      existingSessionData.push(data);
    });
  }
  
  private async processUrlSessionPairs(
    pairs: Array<{ url: string; sessionId: string }>,
    sessionDataMap: Map<string, SessionWithBrowser>,
    urlToSite: Map<string, string>,
    maxPages: number,
    maxRetries: number,
    cacheOptions?: { cacheSizeMB: number; cacheTTLSeconds: number }
  ): Promise<CacheStats | undefined> {
    // Create browsers only for sessions that will be used
    const usedSessionIds = new Set(pairs.map(p => p.sessionId));
    log.normal(`Creating browsers for ${usedSessionIds.size} sessions that will be used`);
    
    // Track which sessions failed to create browsers
    const failedSessions = new Set<string>();
    
    await Promise.all(
      Array.from(usedSessionIds).map(async sessionId => {
        const sessionData = sessionDataMap.get(sessionId);
        if (sessionData && !sessionData.browser) {
          try {
            const { browser, createContext } = await createBrowserFromSession(sessionData.session);
            sessionData.browser = browser;
            sessionData.context = await createContext();
            
            // Use global cache if caching enabled
            if (cacheOptions) {
              // Create global cache once if not already created
              if (!this.globalCache) {
                this.globalCache = new RequestCache({
                  maxSizeBytes: cacheOptions.cacheSizeMB * 1024 * 1024,
                  ttlSeconds: cacheOptions.cacheTTLSeconds
                });
                log.normal(`Created global cache (${cacheOptions.cacheSizeMB}MB, TTL: ${cacheOptions.cacheTTLSeconds}s)`);
              }
              // All sessions share the same cache
              sessionData.cache = this.globalCache;
            }
          } catch (error: any) {
            log.error(`Failed to create browser for session ${sessionId}: ${error.message}`);
            failedSessions.add(sessionId);
            
            // Mark session for removal from tracking
            sessionData.browser = null;
            sessionData.context = null;
            
            // If it's a browserbase session not found error, remove from sessionDataMap
            if (error.message?.includes('not found or expired')) {
              sessionDataMap.delete(sessionId);
              // Also destroy the session to clean up
              try {
                await this.sessionManager.destroySessionByObject(sessionData.session);
              } catch (e) {
                // Ignore cleanup errors
              }
            }
          }
        }
      })
    );
    
    // Filter out pairs for failed sessions
    const validPairs = pairs.filter(p => !failedSessions.has(p.sessionId));
    
    if (validPairs.length === 0) {
      log.error('All browser creation failed, skipping this batch');
      return undefined;
    }
    
    if (failedSessions.size > 0) {
      log.normal(`Continuing with ${validPairs.length} working sessions (${failedSessions.size} failed)`);
    }
    
    // Process each URL-session pair (only valid ones)
    await Promise.all(validPairs.map(async (pair) => {
      const sessionData = sessionDataMap.get(pair.sessionId);
      const site = urlToSite.get(pair.url);
      
      if (!sessionData?.browser || !site) {
        log.error(`Missing session or site for ${pair.url}`);
        return;
      }
      
      await this.processUrlWithRetries(
        pair.url,
        site,
        sessionData,
        maxPages,
        maxRetries
      );
    }));
    
    // Collect cache statistics if caching was enabled
    if (cacheOptions) {
      let totalHits = 0;
      let totalMisses = 0;
      let totalSizeBytes = 0;
      
      for (const sessionData of sessionDataMap.values()) {
        if (sessionData.cache) {
          const stats = sessionData.cache.getStats();
          totalHits += stats.hits;
          totalMisses += stats.misses;
          totalSizeBytes += stats.sizeBytes;
        }
      }
      
      const hitRate = totalHits + totalMisses > 0 
        ? (totalHits / (totalHits + totalMisses)) * 100
        : 0;
      
      return {
        hits: totalHits,
        misses: totalMisses,
        hitRate,
        totalSizeMB: totalSizeBytes / 1024 / 1024
      };
    }
    
    return undefined;
  }
  
  private async processUrlWithRetries(
    url: string,
    site: string,
    sessionData: SessionWithBrowser,
    maxPages: number,
    maxRetries: number
  ): Promise<void> {
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.processUrl(url, site, sessionData, maxPages);
        return; // Success
      } catch (error) {
        lastError = error as Error;
        const isNetworkError = this.isNetworkError(error);
        const isTargetClosedError = lastError.message.includes('Target page, context or browser has been closed');
        
        if (isTargetClosedError) {
          // For target closed errors, don't mark as failed - leave for next batch
          log.error(`Target closed while processing ${url}: ${lastError.message}`);
          log.normal(`URL ${url} will be retried in the next batch`);
          // Don't update pagination state - leave it incomplete for retry
          return;
        }
        
        const isMissingScraper = this.isMissingScraperError(lastError);
        if (isMissingScraper) {
          // Missing scraper is a permanent error - don't retry
          log.error(`Missing scraper for ${url}: ${lastError.message}`);
          this.siteManager.updatePaginationState(url, {
            collectedUrls: [],
            completed: true,
            failureCount: 1,
            failureHistory: [`Missing scraper: ${lastError.message}`]
          });
          return;
        }
        
        if (!isNetworkError || attempt === maxRetries) {
          // Non-network error or final attempt
          log.error(`Failed to process ${url} (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}`);
          this.siteManager.updatePaginationState(url, {
            collectedUrls: [],
            completed: true,
            failureCount: attempt + 1,
            failureHistory: [lastError.message]
          });
          return;
        }
        
        log.debug(`Network error on ${url}, retrying (attempt ${attempt + 1}/${maxRetries + 1})`);
        // Add a delay before retry to avoid hammering the server
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1))); // 2s, 4s, 6s...
      }
    }
  }
  
  private async processUrl(
    url: string,
    site: string,
    sessionData: SessionWithBrowser,
    maxPages: number
  ): Promise<void> {
    const scraper = await loadScraper(site);
    const page: Page = await sessionData.context.newPage();
    
    try {
      // Enable caching for this page
      if (sessionData.cache) {
        await sessionData.cache.enableForPage(page);
      }
      
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      const uniqueUrls = new Set<string>();
      let currentPage = 1;
      
      // Collect from first page
      const firstPageUrls = await scraper.getItemUrls(page);
      firstPageUrls.forEach(url => uniqueUrls.add(url));
      log.normal(`[${site}] ${url} page 1: ${firstPageUrls.size} items (${uniqueUrls.size} unique total)`);
      
      // Paginate
      while (currentPage < maxPages) {
        const hasMore = await scraper.paginate(page);
        if (!hasMore) break;
        
        currentPage++;
        const beforeCount = uniqueUrls.size;
        const urls = await scraper.getItemUrls(page);
        urls.forEach(url => uniqueUrls.add(url));
        const newItems = uniqueUrls.size - beforeCount;
        log.normal(`[${site}] ${url} page ${currentPage}: ${urls.size} items (${newItems} new, ${uniqueUrls.size} unique total)`);
      }
      
      // Convert Set to Array for pagination state
      const pageUrls = Array.from(uniqueUrls);
      
      // Update pagination state
      this.siteManager.updatePaginationState(url, {
        collectedUrls: pageUrls,
        completed: true
      });
      
      log.normal(`[${site}] Collected ${pageUrls.length} unique URLs from ${url}`);
      
    } finally {
      try {
        // Unroute all handlers before closing to prevent hanging promises
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.close();
      } catch (error) {
        // Ignore errors during cleanup
        log.debug(`Error during page cleanup: ${error}`);
      }
    }
  }
  
  private isNetworkError(error: any): boolean {
    const message = error?.message?.toLowerCase() || '';
    return message.includes('timeout') || 
           message.includes('network') || 
           message.includes('connection') ||
           message.includes('navigation') ||
           message.includes('err_aborted') ||
           message.includes('frame was detached');
  }
  
  private isMissingScraperError(error: any): boolean {
    const message = error?.message || '';
    return message.includes('Failed to load scraper') || 
           message.includes('Cannot find module') ||
           message.includes('ERR_MODULE_NOT_FOUND');
  }
  
  private async commitPartialRuns(
    sitesToCommit: Set<string>,
    errors: Map<string, string>
  ): Promise<void> {
    for (const site of sitesToCommit) {
      try {
        const run = await this.siteManager.commitPartialRun(site);
        log.normal(`✓ Committed run ${run.id} for ${site}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Failed to commit run for ${site}: ${message}`);
        errors.set(site, message);
      }
    }
  }
  
  private async cleanupBrowsers(sessionDataMap: Map<string, SessionWithBrowser>): Promise<void> {
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
  }
  
  private getPartialRunForSite(site: string): any {
    // Access the private partialRuns map through a workaround
    // In a real implementation, we would expose a getter method on SiteManager
    const siteManagerAny = this.siteManager as any;
    return siteManagerAny.partialRuns?.get(site);
  }
}