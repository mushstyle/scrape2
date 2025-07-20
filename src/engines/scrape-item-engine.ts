import { logger } from '../utils/logger.js';
import { SiteManager } from '../services/site-manager.js';
import { SessionManager } from '../services/session-manager.js';
import { targetsToSessions } from '../core/distributor.js';
import { loadScraper } from '../drivers/scraper-loader.js';
import { createBrowserFromSession } from '../drivers/browser.js';
import { urlsToScrapeTargets } from '../utils/scrape-target-utils.js';
import { RequestCache } from '../drivers/cache.js';
import { ETLDriver } from '../drivers/etl.js';
import type { Session } from '../types/session.js';
import type { SessionInfo } from '../core/distributor.js';
import type { ScrapeTarget } from '../types/scrape-target.js';
import type { Item } from '../types/item.js';
import type { Page } from 'playwright';

const log = logger.createContext('scrape-item-engine');

export interface ScrapeItemOptions {
  sites?: string[];  // If not specified, scrape all sites with pending items
  exclude?: string[];  // Sites to exclude (takes precedence over sites)
  since?: Date;  // Only process runs created after this date
  instanceLimit?: number;  // Default: 10
  itemLimit?: number;  // Max items per site, default: 100
  disableCache?: boolean;  // Cache ON by default
  cacheSizeMB?: number;  // Default: 100
  cacheTTLSeconds?: number;  // Default: 300 (5 minutes)
  noSave?: boolean;  // Save to ETL by default
  localHeadless?: boolean;  // Use local browser in headless mode
  localHeaded?: boolean;  // Use local browser in headed mode
  sessionTimeout?: number;  // Session timeout in seconds (browserbase only)
  maxRetries?: number;  // Default: 2 (for network errors)
}

export interface ScrapeItemResult {
  success: boolean;
  itemsScraped: number;
  itemsBySite: Map<string, Item[]>;
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

interface UrlWithRunInfo {
  url: string;
  runId: string;
  domain: string;
}

export class ScrapeItemEngine {
  private etlDriver: ETLDriver;
  
  constructor(
    private siteManager: SiteManager,
    private sessionManager: SessionManager
  ) {
    this.etlDriver = new ETLDriver();
  }

  async scrapeItems(options: ScrapeItemOptions): Promise<ScrapeItemResult> {
    const startTime = Date.now();
    const errors = new Map<string, string>();
    const itemsBySite = new Map<string, Item[]>();
    
    // Set defaults
    const instanceLimit = options.instanceLimit || 10;
    const itemLimit = options.itemLimit || Infinity;  // NO LIMIT by default!
    const cacheSizeMB = options.cacheSizeMB || 100;
    const cacheTTLSeconds = options.cacheTTLSeconds || 300;
    const maxRetries = options.maxRetries || 2;
    
    try {
      // Step 1: Get sites to process and their pending items
      const { urlsWithRunInfo, urlToSite } = await this.collectPendingItems(
        options.sites,
        itemLimit,
        options.since,
        options.exclude
      );
      
      if (urlsWithRunInfo.length === 0) {
        log.normal('No pending items to scrape');
        return {
          success: true,
          itemsScraped: 0,
          itemsBySite,
          errors,
          duration: Date.now() - startTime
        };
      }
      
      log.normal(`Found ${urlsWithRunInfo.length} pending items across ${new Set(urlsWithRunInfo.map(u => u.domain)).size} sites`);
      
      // Convert to ScrapeTargets
      const allTargets = urlsToScrapeTargets(urlsWithRunInfo.map(u => u.url));
      
      // Process all items in batches
      let processedCount = 0;
      let batchNumber = 1;
      let cacheStats: CacheStats | undefined;
      const allScrapedItems: Item[] = []; // Collect all items for batch upload
      
      while (processedCount < allTargets.length) {
        const batchStart = processedCount;
        const batchEnd = Math.min(processedCount + instanceLimit, allTargets.length);
        const targetsToProcess = allTargets.slice(batchStart, batchEnd);
        const urlsToProcess = urlsWithRunInfo.slice(batchStart, batchEnd);
        
        log.normal(`\nBatch ${batchNumber}: Processing items ${batchStart + 1}-${batchEnd} of ${allTargets.length}`);
        
        // Get existing sessions
        const existingSessions = await this.sessionManager.getActiveSessions();
        const sessionDataMap = new Map<string, SessionWithBrowser>();
        
        // Convert existing sessions to SessionWithBrowser format
        const existingSessionData = this.convertSessionsToSessionData(existingSessions, sessionDataMap);
        log.normal(`Found ${existingSessionData.length} existing sessions`);
        
        // Get site configs with blocked proxies
        const sitesToProcess = Array.from(new Set(urlsToProcess.map(u => u.domain)));
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
        
        log.normal(`First pass: Matched ${firstPassPairs.length} items to existing sessions`);
        
        // Mark used sessions
        firstPassPairs.forEach(pair => {
          const session = sessionDataMap.get(pair.sessionId);
          if (session) session.inUse = true;
        });
        
        // Terminate excess sessions
        const excessSessions = existingSessionData.filter(s => !s.inUse);
        if (excessSessions.length > 0) {
          log.normal(`Terminating ${excessSessions.length} excess sessions`);
          await Promise.all(excessSessions.map(s => s.session.cleanup()));
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
            sessionDataMap, 
            existingSessionData,
            options
          );
          
          // Second pass with all sessions
          finalPairs = targetsToSessions(
            targetsToProcess,
            existingSessionData.map(s => s.sessionInfo),
            relevantSiteConfigs
          );
          
          log.normal(`Second pass: Matched ${finalPairs.length} items total (limit: ${instanceLimit})`);
        }
        
        // Process URL-session pairs for this batch
        const batchItems: Map<string, Item[]> = new Map();
        const batchCacheStats = await this.processUrlSessionPairs(
          finalPairs,
          sessionDataMap,
          urlsToProcess,
          maxRetries,
          options.disableCache ? undefined : { cacheSizeMB, cacheTTLSeconds },
          batchItems,
          errors,
          true // Always skip save during batch processing, we'll save all at once later
        );
        
        // Collect items from this batch
        for (const [site, items] of batchItems) {
          if (!itemsBySite.has(site)) {
            itemsBySite.set(site, []);
          }
          itemsBySite.get(site)!.push(...items);
          allScrapedItems.push(...items);
        }
        
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
        
        // Clean up browsers for this batch
        await this.cleanupBrowsers(sessionDataMap);
        
        processedCount += targetsToProcess.length;
        batchNumber++;
      }
      
      // Batch upload all scraped items at once if not noSave
      if (!options.noSave && allScrapedItems.length > 0) {
        log.normal(`Uploading ${allScrapedItems.length} items to ETL API`);
        const etlDriver = new ETLDriver();
        await etlDriver.uploadItems(allScrapedItems);
      }
      
      const totalItems = Array.from(itemsBySite.values()).reduce((sum, items) => sum + items.length, 0);
      
      return {
        success: errors.size === 0,
        itemsScraped: totalItems,
        itemsBySite,
        errors,
        duration: Date.now() - startTime,
        cacheStats
      };
      
    } catch (error) {
      log.error('Item scraping failed:', error);
      throw error;
    }
  }
  
  private async collectPendingItems(
    sites: string[] | undefined,
    itemLimit: number,
    since?: Date,
    exclude?: string[]
  ): Promise<{
    urlsWithRunInfo: UrlWithRunInfo[];
    urlToSite: Map<string, string>;
  }> {
    const urlsWithRunInfo: UrlWithRunInfo[] = [];
    const urlToSite = new Map<string, string>();
    
    // Get sites to process
    let sitesToProcess: string[];
    if (sites && sites.length > 0) {
      sitesToProcess = sites;
    } else {
      // Get all sites with active runs
      const runs = await this.siteManager.listRuns({ status: 'processing', since });
      const pendingRuns = await this.siteManager.listRuns({ status: 'pending', since });
      const allRuns = [...runs.runs, ...pendingRuns.runs];
      
      // Get unique domains
      sitesToProcess = Array.from(new Set(allRuns.map(run => run.domain)));
      
      if (since) {
        log.normal(`Processing runs created after ${since.toISOString()}: ${allRuns.length} active runs found`);
      }
    }
    
    // Apply exclude filter (takes precedence)
    if (exclude && exclude.length > 0) {
      const excludeSet = new Set(exclude);
      sitesToProcess = sitesToProcess.filter(site => !excludeSet.has(site));
      log.normal(`Excluded ${exclude.length} sites: ${exclude.join(', ')}`);
    }
    
    // For each site, get pending items from active runs
    for (const site of sitesToProcess) {
      const activeRun = await this.siteManager.getActiveRun(site);
      if (!activeRun) {
        log.debug(`No active run for ${site}`);
        continue;
      }
      
      const pendingItems = await this.siteManager.getPendingItems(activeRun.id);
      const itemsToProcess = pendingItems.slice(0, itemLimit);
      
      for (const item of itemsToProcess) {
        urlsWithRunInfo.push({
          url: item.url,
          runId: activeRun.id,
          domain: site
        });
        urlToSite.set(item.url, site);
      }
      
      if (itemsToProcess.length > 0) {
        log.normal(`${site}: ${itemsToProcess.length} pending items (run ${activeRun.id})`);
      }
    }
    
    return { urlsWithRunInfo, urlToSite };
  }
  
  private convertSessionsToSessionData(
    sessions: Session[],
    sessionDataMap: Map<string, SessionWithBrowser>
  ): SessionWithBrowser[] {
    return sessions.map((session, i) => {
      const sessionInfo: SessionInfo = {
        id: `existing-${i}`,
        proxyType: session.local?.proxy?.type as any || 'none',
        proxyId: session.local?.proxy?.id,
        proxyGeo: session.local?.proxy?.geo
      };
      const data = { session, sessionInfo };
      sessionDataMap.set(sessionInfo.id, data);
      return data;
    });
  }
  
  private async createNewSessions(
    sessionsNeeded: number,
    targetsToProcess: ScrapeTarget[],
    firstPassPairs: Array<{ url: string; sessionId: string }>,
    urlToSite: Map<string, string>,
    sessionDataMap: Map<string, SessionWithBrowser>,
    existingSessionData: SessionWithBrowser[],
    options: ScrapeItemOptions
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
    
    const newSessions = await Promise.all(
      newSessionRequests.map(req => this.sessionManager.createSession(req))
    ) as Session[];
    log.normal(`Created ${newSessions.length} new sessions`);
    
    // Add new sessions to our tracking
    newSessions.forEach((session, i) => {
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
  }
  
  private async processUrlSessionPairs(
    pairs: Array<{ url: string; sessionId: string }>,
    sessionDataMap: Map<string, SessionWithBrowser>,
    urlsWithRunInfo: UrlWithRunInfo[],
    maxRetries: number,
    cacheOptions: { cacheSizeMB: number; cacheTTLSeconds: number } | undefined,
    itemsBySite: Map<string, Item[]>,
    errors: Map<string, string>,
    noSave: boolean | undefined
  ): Promise<CacheStats | undefined> {
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
          
          // Create cache for this session if caching enabled
          if (cacheOptions) {
            sessionData.cache = new RequestCache({
              maxSizeBytes: cacheOptions.cacheSizeMB * 1024 * 1024,
              ttlSeconds: cacheOptions.cacheTTLSeconds
            });
          }
        }
      })
    );
    
    // Create a map from URL to run info for easy lookup
    const urlToRunInfo = new Map<string, UrlWithRunInfo>();
    urlsWithRunInfo.forEach(info => urlToRunInfo.set(info.url, info));
    
    // Process each URL-session pair
    await Promise.all(pairs.map(async (pair) => {
      const sessionData = sessionDataMap.get(pair.sessionId);
      const runInfo = urlToRunInfo.get(pair.url);
      
      if (!sessionData?.browser || !runInfo) {
        log.error(`Missing session or run info for ${pair.url}`);
        return;
      }
      
      await this.processItemWithRetries(
        pair.url,
        runInfo,
        sessionData,
        maxRetries,
        itemsBySite,
        errors,
        noSave
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
  
  private async processItemWithRetries(
    url: string,
    runInfo: UrlWithRunInfo,
    sessionData: SessionWithBrowser,
    maxRetries: number,
    itemsBySite: Map<string, Item[]>,
    errors: Map<string, string>,
    noSave: boolean | undefined
  ): Promise<void> {
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const item = await this.processItem(url, runInfo.domain, sessionData);
        
        // Save to ETL if not noSave
        if (!noSave) {
          const result = await this.etlDriver.addItem(item);
          if (!result.success) {
            throw new Error(`Failed to save item: ${result.error}`);
          }
        }
        
        // Update run status - mark as done
        await this.siteManager.updateItemStatus(runInfo.runId, url, { done: true });
        
        // Add to results
        const siteItems = itemsBySite.get(runInfo.domain) || [];
        siteItems.push(item);
        itemsBySite.set(runInfo.domain, siteItems);
        
        log.normal(`✓ Scraped item from ${url}`);
        return; // Success
        
      } catch (error) {
        lastError = error as Error;
        const isNetworkError = this.isNetworkError(error);
        
        if (!isNetworkError || attempt === maxRetries) {
          // Non-network error or final attempt
          log.error(`Failed to scrape ${url} (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}`);
          
          // Update run status based on error type
          if (isNetworkError) {
            // Network error after retries - mark as failed
            await this.siteManager.updateItemStatus(runInfo.runId, url, { failed: true });
          } else {
            // Other error - mark as invalid
            await this.siteManager.updateItemStatus(runInfo.runId, url, { invalid: true });
          }
          
          errors.set(url, lastError.message);
          return;
        }
        
        log.debug(`Network error on ${url}, retrying (attempt ${attempt + 1}/${maxRetries + 1})`);
      }
    }
  }
  
  private async processItem(
    url: string,
    site: string,
    sessionData: SessionWithBrowser
  ): Promise<Item> {
    const scraper = await loadScraper(site);
    const page: Page = await sessionData.context.newPage();
    
    try {
      // Enable caching for this page
      if (sessionData.cache) {
        await sessionData.cache.enableForPage(page);
      }
      
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      // Scrape the item
      const item = await scraper.scrapeItem(page);
      
      // Ensure sourceUrl is set
      if (!item.sourceUrl) {
        item.sourceUrl = url;
      }
      
      return item;
      
    } finally {
      await page.close();
    }
  }
  
  private isNetworkError(error: any): boolean {
    const message = error?.message?.toLowerCase() || '';
    return message.includes('timeout') || 
           message.includes('network') || 
           message.includes('connection') ||
           message.includes('navigation');
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
}