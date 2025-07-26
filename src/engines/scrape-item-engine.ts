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
  cacheSizeMB?: number;  // Default: 250
  cacheTTLSeconds?: number;  // Default: 300 (5 minutes)
  blockImages?: boolean;  // Block images in cache (default: true)
  noSave?: boolean;  // Save to ETL by default
  localHeadless?: boolean;  // Use local browser in headless mode
  localHeaded?: boolean;  // Use local browser in headed mode
  sessionTimeout?: number;  // Session timeout in seconds (browserbase only)
  maxRetries?: number;  // Default: 1 (for network errors)
  retryFailedItems?: boolean;  // Include previously failed items
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
  invalidated?: boolean;  // Set to true when browser crashes
  statsBeforeUrl?: any;  // Temporary cache stats tracking
}

interface UrlWithRunInfo {
  url: string;
  runId: string;
  domain: string;
}

export class ScrapeItemEngine {
  private etlDriver: ETLDriver;
  private sessionDataMap: Map<string, SessionWithBrowser> = new Map();
  private globalCache: RequestCache | null = null;
  
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
    const urlToSite = new Map<string, string>();
    
    // Set defaults
    const instanceLimit = options.instanceLimit || 10;
    const itemLimit = options.itemLimit || Infinity;  // NO LIMIT by default!
    const cacheSizeMB = options.cacheSizeMB || 250;
    const cacheTTLSeconds = options.cacheTTLSeconds || 300;
    const maxRetries = options.maxRetries || 1;
    
    // Log configuration
    log.normal('Scrape items configuration:');
    log.normal(`  Instance limit: ${instanceLimit}`);
    log.normal(`  Item limit: ${itemLimit === Infinity ? 'unlimited' : itemLimit}`);
    log.normal(`  Cache: ${options.disableCache ? 'disabled' : `${cacheSizeMB}MB, TTL: ${cacheTTLSeconds}s`}`);
    log.normal(`  Max retries: ${maxRetries}`);
    if (options.sessionTimeout) {
      log.normal(`  Session timeout: ${options.sessionTimeout}s`);
    }
    if (options.localHeaded) {
      log.normal(`  Browser: local (headed)`);
    } else if (options.localHeadless) {
      log.normal(`  Browser: local (headless)`);
    } else {
      log.normal(`  Browser: browserbase`);
    }
    if (options.noSave) {
      log.normal(`  Save to ETL: disabled`);
    }
    if (options.retryFailedItems) {
      log.normal(`  Retry failed items: enabled`);
    }
    
    try {
      // Create global cache once at the start if caching enabled
      if (!options.disableCache && !this.globalCache) {
        this.globalCache = new RequestCache({
          maxSizeBytes: cacheSizeMB * 1024 * 1024,
          ttlSeconds: cacheTTLSeconds,
          blockImages: options.blockImages !== false  // Default to true
        });
        log.normal(`Created global cache`);
      }
      
      // Process all items in batches
      let batchNumber = 1;
      let cacheStats: CacheStats | undefined;
      
      while (true) {
        // Get pending items for this batch
        const { urlsWithRunInfo: batchUrlsWithRunInfo, urlToSite: batchUrlToSite } = await this.collectPendingItems(
          options.sites,
          instanceLimit,  // Only collect up to instanceLimit items per batch
          options.since,
          options.exclude,
          options.retryFailedItems
        );
        
        if (batchUrlsWithRunInfo.length === 0) {
          log.normal('No more pending items to process');
          break;
        }
        
        log.normal(`\nBatch ${batchNumber}: Processing ${batchUrlsWithRunInfo.length} items`);
        
        // Convert to ScrapeTargets
        const targetsToProcess = urlsToScrapeTargets(batchUrlsWithRunInfo.map(u => u.url));
        
        // Update urlToSite map
        for (const [url, site] of batchUrlToSite) {
          urlToSite.set(url, site);
        }
        
        // Reset inUse flags at start of each batch
        Array.from(this.sessionDataMap.values()).forEach(sessionData => {
          sessionData.inUse = false;
        });
        
        // Get existing sessions
        const existingSessions = await this.sessionManager.getActiveSessions();
        
        // Convert existing sessions to SessionWithBrowser format
        const allSessionData = this.convertSessionsToSessionData(existingSessions, this.sessionDataMap);
        
        // Filter out invalidated sessions (browser crashed)
        const invalidatedSessions = allSessionData.filter(s => s.invalidated);
        const existingSessionData = allSessionData.filter(s => !s.invalidated);
        
        if (invalidatedSessions.length > 0) {
          log.normal(`Found ${invalidatedSessions.length} invalidated sessions that need cleanup`);
          // Clean up invalidated sessions
          await Promise.all(invalidatedSessions.map(async sessionData => {
            try {
              if (sessionData.browser) {
                await sessionData.browser.close();
              }
              // Also destroy the session in SessionManager
              await this.sessionManager.destroySessionByObject(sessionData.session);
            } catch (error) {
              log.debug(`Error cleaning up invalidated session: ${error}`);
            }
            // Remove from map
            this.sessionDataMap.delete(sessionData.sessionInfo.id);
          }));
        }
        
        log.normal(`Found ${existingSessionData.length} valid existing sessions`);
        
        // Get site configs with blocked proxies
        const sitesToProcess = Array.from(new Set(batchUrlsWithRunInfo.map(u => u.domain)));
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
          // Remove from our map
          excessSessions.forEach(s => {
            const sessionId = this.getSessionId(s.session);
            this.sessionDataMap.delete(sessionId);
          });
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
            batchUrlToSite, 
            this.sessionDataMap, 
            existingSessionData,
            options
          );
          
          // Second pass with all sessions (including newly created ones)
          const allCurrentSessions = Array.from(this.sessionDataMap.values());
          finalPairs = targetsToSessions(
            targetsToProcess,
            allCurrentSessions.map(s => s.sessionInfo),
            relevantSiteConfigs
          );
          
          log.normal(`Second pass: Matched ${finalPairs.length} items total (limit: ${instanceLimit})`);
        }
        
        // Process URL-session pairs for this batch
        const batchItems: Map<string, Item[]> = new Map();
        const successfulUrls: Array<{url: string, runId: string}> = [];
        
        const batchCacheStats = await this.processUrlSessionPairs(
          finalPairs,
          this.sessionDataMap,
          batchUrlsWithRunInfo,
          maxRetries,
          options.disableCache ? undefined : { cacheSizeMB, cacheTTLSeconds },
          batchItems,
          errors,
          options.noSave,
          successfulUrls
        );
        
        // Collect items from this batch
        Array.from(batchItems.entries()).forEach(([site, items]) => {
          if (!itemsBySite.has(site)) {
            itemsBySite.set(site, []);
          }
          itemsBySite.get(site)!.push(...items);
        });
        
        // No need for summary since we log each URL
        
        // Upload items from this batch immediately if not noSave
        if (!options.noSave && batchItems.size > 0) {
          const batchItemsArray: Item[] = [];
          Array.from(batchItems.values()).forEach(items => {
            batchItemsArray.push(...items);
          });
          if (batchItemsArray.length > 0) {
            log.debug(`Uploading ${batchItemsArray.length} items to ETL API`);
            const batchResult = await this.etlDriver.addItemsBatch(batchItemsArray);
            if (batchResult.failed.length > 0) {
              log.error(`Failed to upload ${batchResult.failed.length} items in batch ${batchNumber}`);
            }
            
            // Mark successfully uploaded items as done in the database
            // We trust that if ETL batch was successful, all items can be marked done
            if (successfulUrls.length > 0 && batchResult.successful.length > 0) {
              log.normal(`Batch ${batchNumber} complete: ${successfulUrls.length} items scraped and saved`);
              const updates = successfulUrls.map(({ url, runId }) => ({
                url,
                runId,
                status: { done: true }
              }));
              
              // Group updates by runId for efficiency
              const updatesByRun = new Map<string, Array<{url: string; status: {done: boolean}}>>();
              for (const update of updates) {
                if (!updatesByRun.has(update.runId)) {
                  updatesByRun.set(update.runId, []);
                }
                updatesByRun.get(update.runId)!.push({
                  url: update.url,
                  status: update.status
                });
              }
              
              // Batch update for each run
              for (const [runId, runUpdates] of Array.from(updatesByRun.entries())) {
                try {
                  await this.siteManager.updateItemStatuses(runId, runUpdates.map(u => ({
                    url: u.url,
                    status: u.status
                  })));
                } catch (error) {
                  log.error(`Failed to update ${runUpdates.length} items in run ${runId}:`, error);
                }
              }
            }
          }
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
        
        // Do NOT clean up browsers between batches - we want to reuse them!
        
        batchNumber++;
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
    } finally {
      // Clean up all sessions at the very end
      log.debug('Cleaning up all sessions');
      await this.cleanupBrowsers(this.sessionDataMap);
      await this.sessionManager.destroyAllSessions();
      this.sessionDataMap.clear();
      this.globalCache = null;
    }
  }
  
  private async collectPendingItems(
    sites: string[] | undefined,
    itemLimit: number,
    since?: Date,
    exclude?: string[],
    retryFailedItems?: boolean
  ): Promise<{
    urlsWithRunInfo: UrlWithRunInfo[];
    urlToSite: Map<string, string>;
  }> {
    const urlToSite = new Map<string, string>();
    
    // Get sites to process
    let sitesToProcess: string[];
    if (sites && sites.length > 0) {
      sitesToProcess = sites;
    } else {
      // Get all unique domains that have active runs
      // SiteManager.getPendingItemsWithLimits will handle getting only the LATEST run per domain
      const sitesWithActiveRuns = await this.siteManager.getSitesWithActiveRuns();
      sitesToProcess = sitesWithActiveRuns;
      
      log.normal(`Found ${sitesToProcess.length} sites with active runs`);
      
      if (sitesToProcess.length === 0) {
        log.normal('No active runs found. To process specific sites, use --sites');
      }
    }
    
    // Apply exclude filter (takes precedence)
    if (exclude && exclude.length > 0) {
      const excludeSet = new Set(exclude);
      sitesToProcess = sitesToProcess.filter(site => !excludeSet.has(site));
      log.normal(`Excluded ${exclude.length} sites: ${exclude.join(', ')}`);
    }
    
    // Get pending items from all sites, respecting session limits
    // This method automatically gets only the LATEST run per domain
    const urlsWithRunInfo = await this.siteManager.getPendingItemsWithLimits(
      sitesToProcess,
      itemLimit,
      retryFailedItems
    );
    
    // Build urlToSite map
    for (const item of urlsWithRunInfo) {
      urlToSite.set(item.url, item.domain);
    }
    
    return { urlsWithRunInfo, urlToSite };
  }
  
  private convertSessionsToSessionData(
    sessions: Session[],
    sessionDataMap: Map<string, SessionWithBrowser>
  ): SessionWithBrowser[] {
    return sessions.map((session) => {
      // Use the actual session ID so it can be matched across batches
      const sessionId = this.getSessionId(session);
      
      // Check if we already have this session in our map
      const existing = sessionDataMap.get(sessionId);
      if (existing) {
        return existing;
      }
      
      // For browserbase sessions, proxy info is in session.browserbase, not session.local!
      const proxyInfo = session.provider === 'browserbase' ? session.browserbase?.proxy : session.local?.proxy;
      
      const sessionInfo: SessionInfo = {
        id: sessionId,
        proxyType: proxyInfo?.type as any || 'none',
        proxyId: proxyInfo?.id,
        proxyGeo: proxyInfo?.geo
      };
      const data: SessionWithBrowser = { session, sessionInfo };
      sessionDataMap.set(sessionInfo.id, data);
      return data;
    });
  }
  
  private getSessionId(session: Session): string {
    if (session.provider === 'browserbase') {
      return session.browserbase!.id;
    } else {
      // For local sessions, generate a stable ID
      return `local-${Date.now()}`;
    }
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
    for (const [domain, count] of Array.from(domainCounts.entries())) {
      const proxy = await this.siteManager.getProxyForDomain(domain);
      log.normal(`  ${domain}: ${count} sessions (${proxy?.type || 'no proxy'})`);
    }
    
    // Create sessions based on requirements
    const newSessionRequests: Array<{domain: string, proxy: any, browserType?: string, headless?: boolean, timeout?: number}> = [];
    for (const [domain, count] of Array.from(domainCounts.entries())) {
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
    urlsWithRunInfo: UrlWithRunInfo[],
    maxRetries: number,
    cacheOptions: { cacheSizeMB: number; cacheTTLSeconds: number } | undefined,
    itemsBySite: Map<string, Item[]>,
    errors: Map<string, string>,
    noSave: boolean | undefined,
    successfulUrls: Array<{url: string, runId: string}>
  ): Promise<CacheStats | undefined> {
    // Create browsers only for sessions that will be used
    const usedSessionIds = new Set(pairs.map(p => p.sessionId));
    log.normal(`Creating browsers for ${usedSessionIds.size} sessions that will be used`);
    
    await Promise.all(
      Array.from(usedSessionIds).map(async sessionId => {
        const sessionData = sessionDataMap.get(sessionId);
        // Check if browser needs to be created or recreated (if disconnected)
        const needsBrowser = sessionData && (!sessionData.browser || 
          !(sessionData.browser as any).isConnectedSafe?.() || 
          !sessionData.browser.isConnected());
        if (needsBrowser) {
          const { browser, createContext } = await createBrowserFromSession(sessionData.session);
          sessionData.browser = browser;
          sessionData.context = await createContext();
          
          // Use global cache if caching enabled
          if (cacheOptions && this.globalCache) {
            // All sessions share the same cache
            sessionData.cache = this.globalCache;
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
        noSave,
        successfulUrls
      );
    }));
    
    // Collect cache statistics if caching was enabled
    if (cacheOptions) {
      let totalHits = 0;
      let totalMisses = 0;
      let totalSizeBytes = 0;
      
      Array.from(sessionDataMap.values()).forEach(sessionData => {
        if (sessionData.cache) {
          const stats = sessionData.cache.getStats();
          totalHits += stats.hits;
          totalMisses += stats.misses;
          totalSizeBytes += stats.sizeBytes;
        }
      });
      
      const hitRate = totalHits + totalMisses > 0 
        ? (totalHits / (totalHits + totalMisses)) * 100
        : 0;
      
      // TEMPORARY DEBUG: Log cache stats with bandwidth savings
      let totalBytesSaved = 0;
      let totalBytesDownloaded = 0;
      
      Array.from(sessionDataMap.values()).forEach(sessionData => {
        if (sessionData.cache) {
          const stats = sessionData.cache.getStats();
          totalBytesSaved += stats.bytesSaved;
          totalBytesDownloaded += stats.bytesDownloaded;
        }
      });
      
      const totalBandwidthNeeded = totalBytesDownloaded + totalBytesSaved;
      const bandwidthSavedPercent = totalBandwidthNeeded > 0 
        ? ((totalBytesSaved / totalBandwidthNeeded) * 100).toFixed(1)
        : '0.0';
      
      log.normal(`[CACHE DEBUG] Batch complete - ${bandwidthSavedPercent}% saved (${(totalBytesSaved / 1024 / 1024).toFixed(1)}/${(totalBandwidthNeeded / 1024 / 1024).toFixed(1)}MB)`);
      
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
    noSave: boolean | undefined,
    successfulUrls: Array<{url: string, runId: string}>
  ): Promise<void> {
    let lastError: Error | undefined;
    
    // Capture cache stats before processing this URL
    if (sessionData.cache) {
      sessionData.statsBeforeUrl = sessionData.cache.getStats();
    }
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const item = await this.processItem(url, runInfo.domain, sessionData);
        
        // Add to results - will mark as done after batch upload
        const siteItems = itemsBySite.get(runInfo.domain) || [];
        siteItems.push(item);
        itemsBySite.set(runInfo.domain, siteItems);
        
        // Track successful URL for batch update
        successfulUrls.push({ url, runId: runInfo.runId });
        
        // TEMPORARY DEBUG: Show cache stats for this URL
        if (sessionData.cache) {
          const statsAfter = sessionData.cache.getStats();
          // Calculate hits/misses for just this URL by subtracting previous stats
          const hitsForUrl = statsAfter.hits - (sessionData.statsBeforeUrl?.hits || 0);
          const missesForUrl = statsAfter.misses - (sessionData.statsBeforeUrl?.misses || 0);
          const bytesSavedForUrl = statsAfter.bytesSaved - (sessionData.statsBeforeUrl?.bytesSaved || 0);
          const bytesDownloadedForUrl = statsAfter.bytesDownloaded - (sessionData.statsBeforeUrl?.bytesDownloaded || 0);
          
          const totalBytesForUrl = bytesDownloadedForUrl + bytesSavedForUrl;
          const savedPercentForUrl = totalBytesForUrl > 0 ? ((bytesSavedForUrl / totalBytesForUrl) * 100).toFixed(1) : '0.0';
          
          log.normal(`✓ Scraped ${url} [CACHE: ${hitsForUrl}/${hitsForUrl + missesForUrl}, ${savedPercentForUrl}% saved]`);
        } else {
          log.normal(`✓ Scraped ${url} [CACHE: disabled]`);
        }
        return; // Success
        
      } catch (error) {
        lastError = error as Error;
        const isNetworkError = this.isNetworkError(error);
        const isBrowserClosed = this.isBrowserClosedError(error);
        
        if (isBrowserClosed) {
          // Browser/page was closed - this is a special case
          log.error(`Browser closed while scraping ${url}: ${lastError.message}`);
          // Mark this session as invalidated so it won't be used again
          sessionData.invalidated = true;
          errors.set(url, 'Browser closed unexpectedly');
          return;
        }
        
        if (!isNetworkError || attempt === maxRetries) {
          // Non-network error or final attempt
          log.error(`Failed to scrape ${url} (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}`);
          
          // Update run status based on error type
          if (isNetworkError) {
            // Network error after retries - mark as failed
            await this.siteManager.updateItemStatus(runInfo.runId, url, { failed: true });
            
            // Auto-block the proxy if it's a datacenter proxy
            const proxy = sessionData.session.provider === 'browserbase' 
              ? sessionData.session.browserbase?.proxy 
              : sessionData.session.local?.proxy;
              
            if (proxy && proxy.type === 'datacenter') {
              await this.siteManager.addBlockedProxy(runInfo.domain, proxy, lastError.message);
            }
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
    
    // Add error handler to prevent crashes from disconnected pages
    page.on('error', (error) => {
      log.error(`Page error for ${url}:`, error.message);
    });
    
    // Listen for page crashes
    page.on('crash', () => {
      log.error(`Page crashed for ${url}`);
    });
    
    // Listen for page close events
    page.on('close', () => {
      log.debug(`Page closed for ${url}`);
    });
    
    try {
      // Enable caching for this page
      if (sessionData.cache) {
        await sessionData.cache.enableForPage(page);
      }
      
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      
      // Scrape the item
      const item = await scraper.scrapeItem(page);
      
      // Ensure sourceUrl is set
      if (!item.sourceUrl) {
        item.sourceUrl = url;
      }
      
      return item;
      
    } finally {
      // Unroute all handlers to avoid errors when closing
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
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
  
  private isBrowserClosedError(error: any): boolean {
    const message = error?.message?.toLowerCase() || '';
    return message.includes('target page, context or browser has been closed') ||
           message.includes('browser has been closed') ||
           message.includes('context has been closed') ||
           message.includes('target closed') ||
           message.includes('session not found') ||
           message.includes('session expired') ||
           message.includes('websocket') ||
           message.includes('disconnected') ||
           message.includes('connection closed') ||
           message.includes('browser is closed') ||
           message.includes('execution context was destroyed') ||
           message.includes('page has been closed');
  }
  
  private async cleanupBrowsers(sessionDataMap: Map<string, SessionWithBrowser>): Promise<void> {
    await Promise.all(
      Array.from(sessionDataMap.values()).map(async sessionData => {
        if (sessionData.browser) {
          try {
            await sessionData.context?.close();
            await sessionData.browser.close();
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      })
    );
  }
}