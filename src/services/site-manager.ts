import { logger } from '../utils/logger.js';
import { 
  getSites,
  createRun,
  getRun,
  listRuns,
  updateRunItem,
  finalizeRun,
  getLatestRunForDomain,
  fetchRun,
  getActiveRuns
} from '../drivers/scrape-runs.js';
import { getSiteConfig } from '../drivers/site-config.js';
import { getSessionLimitForDomain, selectProxyForDomain } from '../drivers/proxy.js';
import type { SiteConfig } from '../types/site-config-types.js';
import type {
  ScrapeRun,
  ScrapeRunItem,
  CreateScrapeRunRequest
} from '../types/scrape-run.js';
import type { ItemStats } from '../types/orchestration.js';
import type { Proxy } from '../types/proxy.js';
import type { PartialScrapeRun, PaginationState, ProxyBlocklistEntry } from '../types/robust-scrape-run.js';
import { getProxyStrategy } from '../drivers/proxy.js';

const log = logger.createContext('site-manager');

export interface SiteState {
  domain: string;
  config: SiteConfig;
  lastScraped?: Date;
  activeSessionCount?: number;
  customData?: Record<string, any>;
  // Scrape run management
  activeRun?: ScrapeRun;
  pendingRun?: ScrapeRun; // Uncommitted run being built
  recentRuns?: ScrapeRun[];
  // URL retry tracking
  retryCount?: Map<string, number>;
  failedUrls?: Set<string>;
  // Proxy blocklist
  proxyBlocklist: Map<string, ProxyBlocklistEntry>; // key is proxy string
}

export interface SiteManagerOptions {
  autoLoad?: boolean;
}

/**
 * Manages site configurations, state, and scrape runs
 * Central hub for all site-related operations including:
 * - Site configurations
 * - Scrape run creation and management
 * - URL retry tracking
 * - Item status updates
 */
export class SiteManager {
  private sites: Map<string, SiteState> = new Map();
  private loaded: boolean = false;
  // In-memory scrape runs not yet committed to ETL API
  private uncommittedRuns: Map<string, ScrapeRun> = new Map();
  // Partial run tracking for robust pagination - map by siteId
  private partialRuns: Map<string, PartialScrapeRun> = new Map();

  constructor(private options: SiteManagerOptions = {}) {
    log.debug('SiteManager initialized');
  }

  /**
   * Load all sites from ETL API and their configurations
   */
  async loadSites(): Promise<void> {
    if (this.loaded && !this.options.autoLoad) {
      log.debug('Sites already loaded, skipping');
      return;
    }

    log.normal('Loading sites from ETL API...');
    
    const sitesResponse = await getSites();
    const allSites = Array.isArray(sitesResponse) 
      ? sitesResponse 
      : (sitesResponse.data || sitesResponse.sites || []);
    
    log.normal(`Found ${allSites.length} sites`);

    // Load configurations in parallel
    const configPromises = allSites.map(async (site: any) => {
      const domain = site._id || site.id || site.domain;
      if (!domain) {
        log.debug('Site missing domain identifier', site);
        return null;
      }

      try {
        const config = await getSiteConfig(domain);
        return { domain, config };
      } catch (error) {
        log.debug(`Failed to load config for ${domain}:`, error);
        return null;
      }
    });

    const results = await Promise.allSettled(configPromises);
    
    // Clear existing sites
    this.sites.clear();

    // Add successfully loaded sites
    let loadedCount = 0;
    results.forEach((result) => {
      if (result.status === 'fulfilled' && result.value) {
        const { domain, config } = result.value;
        this.sites.set(domain, {
          domain,
          config,
          customData: {},
          proxyBlocklist: new Map()
        });
        loadedCount++;
      }
    });

    log.normal(`Successfully loaded ${loadedCount} site configurations`);
    this.loaded = true;
  }

  /**
   * Get all sites
   */
  getAllSites(): SiteState[] {
    return Array.from(this.sites.values());
  }

  /**
   * Get sites with start pages
   */
  getSitesWithStartPages(): SiteState[] {
    return Array.from(this.sites.values()).filter(
      site => site.config.startPages && site.config.startPages.length > 0
    );
  }

  /**
   * Get a specific site by domain
   */
  getSite(domain: string): SiteState | undefined {
    // Handle www prefix
    const normalizedDomain = domain.replace(/^www\./, '');
    return this.sites.get(normalizedDomain);
  }

  /**
   * Get site config by domain
   */
  getSiteConfig(domain: string): SiteConfig | null {
    const site = this.getSite(domain);
    return site ? site.config : null;
  }

  /**
   * Update site state
   */
  updateSite(domain: string, updates: Partial<SiteState>): void {
    const normalizedDomain = domain.replace(/^www\./, '');
    const existing = this.sites.get(normalizedDomain);
    
    if (!existing) {
      log.debug(`Cannot update non-existent site: ${domain}`);
      return;
    }

    this.sites.set(normalizedDomain, {
      ...existing,
      ...updates,
      domain: existing.domain, // Preserve original domain
      config: updates.config || existing.config // Preserve config unless explicitly updated
    });

    log.debug(`Updated site state for ${domain}`);
  }

  /**
   * Update custom data for a site
   */
  updateSiteCustomData(domain: string, key: string, value: any): void {
    const normalizedDomain = domain.replace(/^www\./, '');
    const site = this.sites.get(normalizedDomain);
    
    if (!site) {
      log.debug(`Cannot update custom data for non-existent site: ${domain}`);
      return;
    }

    site.customData = site.customData || {};
    site.customData[key] = value;

    log.debug(`Updated custom data for ${domain}: ${key}`);
  }

  /**
   * Get custom data for a site
   */
  getSiteCustomData(domain: string, key: string): any {
    const site = this.getSite(domain);
    return site?.customData?.[key];
  }

  /**
   * Get start pages for a domain
   * NOTE: This returns ALL start pages. The sessionLimit should be applied
   * during batch processing, not here!
   */
  async getStartPagesForDomain(domain: string): Promise<string[]> {
    const site = this.getSite(domain);
    if (!site || !site.config.startPages) {
      return [];
    }

    // Return ALL start pages - sessionLimit controls concurrent sessions, not total URLs
    return site.config.startPages;
  }
  
  /**
   * Get blocked proxy IDs for proxy selection
   * Uses the existing blocklist system which already handles cooldowns
   * @param domain - The domain to check
   * @returns Array of proxy IDs that are still blocked
   */
  private async getActiveBlockedProxyIds(domain: string): Promise<string[]> {
    // getBlockedProxies already handles cooldown and returns proxy strings
    const blockedProxyStrings = await this.getBlockedProxies(domain);
    
    // Extract proxy IDs from the proxy strings
    // The proxy string format might be like "datacenter:proxy-id" or just "proxy-id"
    // For now, we'll use the whole string as the ID until we understand the format better
    return blockedProxyStrings;
  }

  /**
   * Get proxy for a domain based on its strategy
   * @param domain - The domain to get proxy for
   * @returns Selected proxy or null
   */
  async getProxyForDomain(domain: string): Promise<Proxy | null> {
    const blockedProxyIds = await this.getActiveBlockedProxyIds(domain);
    return selectProxyForDomain(domain, blockedProxyIds);
  }
  
  /**
   * Get session limit for a domain from its proxy strategy
   * @param domain - The domain to get session limit for
   * @returns The session limit
   */
  async getSessionLimitForDomain(domain: string): Promise<number> {
    return getSessionLimitForDomain(domain);
  }

  /**
   * Get unprocessed start pages for all sites, respecting session limits
   * This returns start pages that haven't been completed yet, up to the session limit per domain
   */
  async getUnprocessedStartPagesWithLimits(sites: string[]): Promise<Array<{ url: string; domain: string }>> {
    const results: Array<{ url: string; domain: string }> = [];
    
    for (const domain of sites) {
      const site = this.getSite(domain);
      if (!site || !site.config.startPages?.length) {
        continue;
      }
      
      // Get session limit for this domain
      const sessionLimit = await this.getSessionLimitForDomain(domain);
      
      // Get all start pages
      const allStartPages = site.config.startPages;
      
      // Find which ones are not completed
      const unprocessedPages: string[] = [];
      for (const url of allStartPages) {
        // Check if this URL has a pagination state and if it's completed
        const partialRun = this.partialRuns.get(domain);
        const state = partialRun?.paginationStates.get(url);
        
        // If no state exists or it's not completed, it's unprocessed
        if (!state || !state.completed) {
          unprocessedPages.push(url);
          
          // Stop if we've reached the session limit
          if (unprocessedPages.length >= sessionLimit) {
            break;
          }
        }
      }
      
      // Add to results
      for (const url of unprocessedPages) {
        results.push({ url, domain });
      }
    }
    
    return results;
  }

  /**
   * Get all start pages from all sites
   */
  async getAllStartPages(): Promise<Array<{ url: string; domain: string }>> {
    const urls: Array<{ url: string; domain: string }> = [];

    for (const site of this.sites.values()) {
      const startPages = await this.getStartPagesForDomain(site.domain);
      for (const url of startPages) {
        urls.push({ url, domain: site.domain });
      }
    }

    return urls;
  }

  /**
   * Get site configurations for use with distributor
   */
  getSiteConfigs(): SiteConfig[] {
    return Array.from(this.sites.values()).map(site => site.config);
  }

  /**
   * Get site configurations with blocked proxies
   * @param includeBlockedProxies - Whether to include blockedProxies field (default: true)
   */
  async getSiteConfigsWithBlockedProxies(includeBlockedProxies: boolean = true): Promise<SiteConfig[]> {
    const configs: SiteConfig[] = [];
    
    for (const site of this.sites.values()) {
      if (!includeBlockedProxies) {
        configs.push(site.config);
      } else {
        const blockedProxies = await this.getBlockedProxies(site.domain);
        configs.push({
          ...site.config,
          blockedProxies
        });
      }
    }
    
    return configs;
  }

  /**
   * Add or update a site manually
   */
  addSite(domain: string, config: SiteConfig, state?: Partial<SiteState>): void {
    const normalizedDomain = domain.replace(/^www\./, '');
    
    this.sites.set(normalizedDomain, {
      domain: normalizedDomain,
      config,
      lastScraped: state?.lastScraped,
      activeSessionCount: state?.activeSessionCount,
      customData: state?.customData || {},
      proxyBlocklist: state?.proxyBlocklist || new Map()
    });

    log.debug(`Added/updated site: ${domain}`);
  }

  /**
   * Remove a site
   */
  removeSite(domain: string): boolean {
    const normalizedDomain = domain.replace(/^www\./, '');
    const result = this.sites.delete(normalizedDomain);
    
    if (result) {
      log.debug(`Removed site: ${domain}`);
    }
    
    return result;
  }

  /**
   * Clear all sites
   */
  clear(): void {
    this.sites.clear();
    this.loaded = false;
    log.debug('Cleared all sites');
  }

  /**
   * Get number of loaded sites
   */
  size(): number {
    return this.sites.size;
  }

  /**
   * Check if sites are loaded
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  // ========== Scrape Run Management ==========

  /**
   * Create a new scrape run for a domain
   */
  async createRun(domain: string, urls?: string[]): Promise<ScrapeRun> {
    const request: CreateScrapeRunRequest = { domain };
    if (urls && urls.length > 0) {
      request.urls = urls;
      log.debug(`Adding ${urls.length} URLs to CreateScrapeRunRequest`);
    }
    
    try {
      const run = await createRun(request);
      log.debug(`Received run response with ${run.items?.length || 0} items`);
      log.normal(`Created run ${run.id} for domain ${domain} with ${run.items.length} items`);
      
      // Update site state with the new run
      const site = this.getSite(domain);
      if (site) {
        site.activeRun = run;
        site.lastScraped = new Date();
      }
      
      return run;
    } catch (error) {
      log.error(`Failed to create run for domain ${domain}`, { error });
      throw error;
    }
  }
  
  /**
   * Create a pending (uncommitted) run that can be built up before committing
   */
  createPendingRun(domain: string): ScrapeRun {
    const now = new Date().toISOString();
    const pendingRun: ScrapeRun = {
      id: `pending-${domain}-${Date.now()}`,
      domain,
      status: 'pending',
      created_at: now,
      updated_at: now,
      createdAt: now,
      items: []
    };
    
    this.uncommittedRuns.set(pendingRun.id, pendingRun);
    
    const site = this.getSite(domain);
    if (site) {
      site.pendingRun = pendingRun;
    }
    
    log.debug(`Created pending run ${pendingRun.id} for domain ${domain}`);
    return pendingRun;
  }
  
  /**
   * Add URLs to a pending run
   */
  addUrlsToPendingRun(runId: string, urls: string[]): void {
    const pendingRun = this.uncommittedRuns.get(runId);
    if (!pendingRun) {
      throw new Error(`Pending run ${runId} not found`);
    }
    
    const newItems: ScrapeRunItem[] = urls.map(url => ({
      url,
      done: false,
      failed: false,
      invalid: false
    }));
    
    pendingRun.items.push(...newItems);
    log.debug(`Added ${urls.length} URLs to pending run ${runId}`);
  }
  
  /**
   * Commit a pending run to the ETL API
   */
  async commitPendingRun(runId: string): Promise<ScrapeRun> {
    const pendingRun = this.uncommittedRuns.get(runId);
    if (!pendingRun) {
      throw new Error(`Pending run ${runId} not found`);
    }
    
    // Create the run with all accumulated URLs
    const urls = pendingRun.items.map(item => item.url);
    const committedRun = await this.createRun(pendingRun.domain, urls);
    
    // Clean up
    this.uncommittedRuns.delete(runId);
    const site = this.getSite(pendingRun.domain);
    if (site && site.pendingRun?.id === runId) {
      site.pendingRun = undefined;
    }
    
    log.normal(`Committed pending run ${runId} as ${committedRun.id}`);
    return committedRun;
  }
  
  /**
   * Get active run for a domain (most recent non-completed run)
   */
  async getActiveRun(domain: string): Promise<ScrapeRun | null> {
    // First check in-memory state
    const site = this.getSite(domain);
    if (site?.activeRun && (site.activeRun.status === 'pending' || site.activeRun.status === 'processing')) {
      return site.activeRun;
    }
    
    try {
      // Get the latest run regardless of status
      const response = await listRuns({
        domain,
        limit: 1
      });
      
      if (response.runs.length > 0) {
        const run = response.runs[0];
        
        // Only return runs that might have pending items
        if (run.status === 'processing' || run.status === 'pending' || run.status === 'created') {
          if (site) {
            site.activeRun = run;
          }
          log.debug(`Found ${run.status} run ${run.id} for ${domain}`);
          return run;
        } else {
          log.debug(`Latest run for ${domain} has status ${run.status}, skipping`);
        }
      }
      
      return null;
    } catch (error) {
      log.error(`Failed to get active run for domain ${domain}`, { error });
      return null;
    }
  }
  
  /**
   * Get pending items from a run (not done)
   * @param runId - The run ID
   * @param limit - Optional limit on number of items to return
   */
  async getPendingItems(runId: string, limit?: number, includeFailedItems = false): Promise<ScrapeRunItem[]> {
    // Check if it's an uncommitted run
    const pendingRun = this.uncommittedRuns.get(runId);
    if (pendingRun) {
      const pending = pendingRun.items.filter(item => 
        !item.done && 
        !item.invalid && 
        (includeFailedItems || !item.failed)
      );
      log.debug(`Found ${pending.length} pending items in uncommitted run ${runId}${includeFailedItems ? ' (including failed)' : ''}`);
      return limit ? pending.slice(0, limit) : pending;
    }
    
    try {
      const run = await fetchRun(runId);
      
      // Debug: log item counts
      const doneCount = run.items.filter((item: ScrapeRunItem) => item.done).length;
      const failedCount = run.items.filter((item: ScrapeRunItem) => item.failed).length;
      const invalidCount = run.items.filter((item: ScrapeRunItem) => item.invalid).length;
      
      log.debug(`Run ${runId} items breakdown: total=${run.items.length}, done=${doneCount}, failed=${failedCount}, invalid=${invalidCount}`);
      
      const pendingItems = run.items.filter((item: ScrapeRunItem) => 
        !item.done && 
        !item.invalid && 
        (includeFailedItems || !item.failed)
      );
      log.debug(`Found ${pendingItems.length} pending items in run ${runId}${includeFailedItems ? ' (including failed)' : ''}, returning ${limit ? Math.min(limit, pendingItems.length) : pendingItems.length}`);
      return limit ? pendingItems.slice(0, limit) : pendingItems;
    } catch (error) {
      log.error(`Failed to get pending items for run ${runId}`, { error });
      return [];
    }
  }

  /**
   * Get pending items from multiple sites, respecting session limits
   * This returns pending items from active runs, up to the session limit per domain
   * @param sites - Array of site domains to get items from
   * @param totalLimit - Maximum total items to return across all sites
   * @returns Array of items with domain and run info
   */
  async getPendingItemsWithLimits(
    sites: string[], 
    totalLimit: number = Infinity,
    includeFailedItems = false
  ): Promise<Array<{ url: string; runId: string; domain: string }>> {
    const results: Array<{ url: string; runId: string; domain: string }> = [];
    let totalCollected = 0;
    
    log.debug(`getPendingItemsWithLimits called for ${sites.length} sites, totalLimit: ${totalLimit}, includeFailedItems: ${includeFailedItems}`);
    
    // Specifically check if cos.com is in the list
    if (sites.includes('cos.com')) {
      log.normal(`cos.com is in the sites list!`);
    } else {
      log.normal(`cos.com is NOT in the sites list. Sites: ${sites.slice(0, 5).join(', ')}...`);
    }
    
    for (const domain of sites) {
      // Stop if we've reached the total limit
      if (totalCollected >= totalLimit) {
        break;
      }
      
      // Get active run for this domain
      const activeRun = await this.getActiveRun(domain);
      if (!activeRun) {
        log.debug(`No active run for ${domain}`);
        continue;
      }
      
      log.debug(`Found active run ${activeRun.id} for ${domain} - status: ${activeRun.status}, total items: ${activeRun.items.length}`);
      
      // Get session limit for this domain
      const sessionLimit = await this.getSessionLimitForDomain(domain);
      
      // Calculate how many items we can take from this domain
      const remainingCapacity = totalLimit - totalCollected;
      const domainLimit = Math.min(sessionLimit, remainingCapacity);
      
      log.debug(`Domain ${domain}: sessionLimit=${sessionLimit}, remainingCapacity=${remainingCapacity}, domainLimit=${domainLimit}`);
      
      // Get pending items up to the domain limit
      const pendingItems = await this.getPendingItems(activeRun.id, domainLimit, includeFailedItems);
      
      log.debug(`Got ${pendingItems.length} pending items for ${domain}`);
      
      // Add items to results
      for (const item of pendingItems) {
        results.push({
          url: item.url,
          runId: activeRun.id,
          domain: domain
        });
        totalCollected++;
      }
      
      if (pendingItems.length > 0) {
        log.debug(`${domain}: collected ${pendingItems.length} pending items (sessionLimit: ${sessionLimit})`);
      }
    }
    
    log.normal(`getPendingItemsWithLimits returning ${results.length} total items across ${sites.length} sites`);
    return results;
  }
  
  /**
   * Update item status and optionally upload data
   */
  async updateItemStatus(
    runId: string,
    url: string,
    status: { done?: boolean; failed?: boolean; invalid?: boolean },
    data?: any
  ): Promise<void> {
    // Check if it's an uncommitted run
    const pendingRun = this.uncommittedRuns.get(runId);
    if (pendingRun) {
      log.error(`CRITICAL: Trying to update item in uncommitted run ${runId} - this won't persist!`);
      const item = pendingRun.items.find(i => i.url === url);
      if (item) {
        Object.assign(item, status);
      }
      return;
    }
    
    try {
      await updateRunItem(runId, url, status);
      log.debug(`Updated item ${url} in run ${runId}`, status);
      
      // Update retry tracking
      if (status.failed) {
        const run = await fetchRun(runId);
        const site = this.getSite(run.domain);
        if (site) {
          site.retryCount = site.retryCount || new Map();
          site.failedUrls = site.failedUrls || new Set();
          
          const currentRetries = site.retryCount.get(url) || 0;
          site.retryCount.set(url, currentRetries + 1);
          site.failedUrls.add(url);
        }
      }
      
      // TODO: If data is provided, upload it to appropriate storage
      if (data) {
        log.debug(`Data provided for ${url}, would upload to storage`);
      }
    } catch (error) {
      log.error(`Failed to update item ${url} in run ${runId}`, { error });
      throw error;
    }
  }
  
  /**
   * Batch update item statuses
   */
  async updateItemStatuses(
    runId: string,
    updates: Array<{ url: string; status: { done?: boolean; failed?: boolean; invalid?: boolean }; data?: any }>
  ): Promise<void> {
    // Process updates in parallel with concurrency limit
    const batchSize = 10;
    for (let i = 0; i < updates.length; i += batchSize) {
      const batch = updates.slice(i, i + batchSize);
      await Promise.all(
        batch.map(({ url, status, data }) => this.updateItemStatus(runId, url, status, data))
      );
    }
    log.debug(`Updated ${updates.length} items in run ${runId}`);
  }
  
  /**
   * Finalize a run
   */
  async finalizeRun(runId: string): Promise<void> {
    try {
      // Calculate metadata before finalizing
      const run = await fetchRun(runId);
      const stats = this.calculateRunStats(run);
      
      await finalizeRun(runId);
      log.normal(`Finalized run ${runId}`, stats);
      
      // Update site state
      const site = this.getSite(run.domain);
      if (site && site.activeRun?.id === runId) {
        site.activeRun = undefined;
        site.recentRuns = site.recentRuns || [];
        site.recentRuns.unshift(run);
        // Keep only last 5 runs
        if (site.recentRuns.length > 5) {
          site.recentRuns = site.recentRuns.slice(0, 5);
        }
      }
    } catch (error) {
      log.error(`Failed to finalize run ${runId}`, { error });
      throw error;
    }
  }
  
  /**
   * Get run statistics
   */
  async getRunStats(runId: string): Promise<ItemStats> {
    try {
      const run = await fetchRun(runId);
      return this.calculateRunStats(run);
    } catch (error) {
      log.error(`Failed to get stats for run ${runId}`, { error });
      return {
        total: 0,
        pending: 0,
        completed: 0,
        failed: 0,
        invalid: 0
      };
    }
  }
  
  /**
   * List scrape runs with optional filters
   */
  async listRuns(options: { since?: Date; domain?: string; status?: string } = {}): Promise<{ runs: ScrapeRun[] }> {
    try {
      const listOptions: any = {};
      if (options.since) {
        listOptions.since = options.since;
      }
      if (options.domain) {
        listOptions.domain = options.domain;
      }
      if (options.status) {
        listOptions.status = options.status;
      }
      
      return await listRuns(listOptions);
    } catch (error) {
      log.error('Failed to list runs', { error });
      throw error;
    }
  }
  
  /**
   * Calculate run statistics from a ScrapeRun
   */
  private calculateRunStats(run: ScrapeRun): ItemStats {
    const stats: ItemStats = {
      total: run.items.length,
      pending: 0,
      completed: 0,
      failed: 0,
      invalid: 0
    };
    
    run.items.forEach(item => {
      if (item.done) {
        stats.completed++;
      } else if (item.failed) {
        stats.failed++;
      } else if (item.invalid) {
        stats.invalid++;
      } else {
        stats.pending++;
      }
    });
    
    return stats;
  }
  
  /**
   * Get or create a run for a domain
   */
  async getOrCreateRun(domain: string, urls?: string[]): Promise<ScrapeRun> {
    // Check for existing active run
    const activeRun = await this.getActiveRun(domain);
    if (activeRun) {
      log.normal(`Using existing run ${activeRun.id} for domain ${domain}`);
      return activeRun;
    }
    
    // Create new run
    return this.createRun(domain, urls);
  }
  
  /**
   * Get all sites that have active runs (latest run is pending or processing)
   * @returns Array of domain names with active runs
   */
  async getSitesWithActiveRuns(): Promise<string[]> {
    // First, get all sites
    const response = await getSites();
    const allSites = response.sites || [];
    
    log.debug(`Checking ${allSites.length} sites for active runs`);
    
    const domainsWithActiveRuns: string[] = [];
    
    // For each site, check if it has an active run (like sites:manage does)
    for (const site of allSites) {
      const domain = site._id;
      
      // Get the most recent run for this domain (regardless of status)
      const runsResponse = await listRuns({ 
        domain, 
        limit: 1,
        sortBy: 'createdAt',
        sortOrder: 'desc'
      });
      
      if (runsResponse.runs.length > 0) {
        const run = runsResponse.runs[0];
        // Only include if the run is pending or processing
        if (run.status === 'pending' || run.status === 'processing') {
          domainsWithActiveRuns.push(domain);
          
          if (domain === 'cos.com') {
            log.normal(`cos.com found! Run status: ${run.status}, created: ${run.createdAt}`);
          }
        }
      }
    }
    
    log.normal(`Found ${domainsWithActiveRuns.length} domains with active runs`);
    return domainsWithActiveRuns;
  }

  /**
   * Get URLs that need retry for a domain
   */
  getRetryUrls(domain: string, maxRetries: number = 3): string[] {
    const site = this.getSite(domain);
    if (!site || !site.failedUrls || !site.retryCount) {
      return [];
    }
    
    const retryUrls: string[] = [];
    for (const url of site.failedUrls) {
      const retries = site.retryCount.get(url) || 0;
      if (retries < maxRetries) {
        retryUrls.push(url);
      }
    }
    
    return retryUrls;
  }
  
  /**
   * Clear retry tracking for a domain
   */
  clearRetryTracking(domain: string): void {
    const site = this.getSite(domain);
    if (site) {
      site.retryCount = new Map();
      site.failedUrls = new Set();
    }
  }

  // ========== Partial Run Tracking ==========

  /**
   * Start pagination tracking for a site
   */
  async startPagination(siteId: string, startPages: string[]): Promise<void> {
    // Check if pagination already started for this site
    if (this.partialRuns.has(siteId)) {
      log.debug(`Pagination already started for ${siteId}, skipping initialization`);
      return;
    }
    
    const partialRun: PartialScrapeRun = {
      siteId,
      paginationStates: new Map(
        startPages.map(url => [url, {
          startPageUrl: url,
          collectedUrls: [],
          failureCount: 0,
          failureHistory: [],
          completed: false
        }])
      ),
      totalUrlsCollected: 0,
      createdAt: new Date(),
      committedToDb: false
    };
    this.partialRuns.set(siteId, partialRun);
    log.debug(`Started pagination tracking for ${siteId} with ${startPages.length} start pages`);
  }

  /**
   * Update individual pagination state
   */
  updatePaginationState(startPageUrl: string, update: Partial<PaginationState>): void {
    // Find which partial run contains this start page
    let partialRun: PartialScrapeRun | undefined;
    for (const [siteId, run] of this.partialRuns) {
      if (run.paginationStates.has(startPageUrl)) {
        partialRun = run;
        break;
      }
    }
    
    if (!partialRun) {
      throw new Error(`No partial run found containing start page ${startPageUrl}`);
    }
    
    const state = partialRun.paginationStates.get(startPageUrl);
    if (!state) {
      throw new Error(`No pagination state found for ${startPageUrl}`);
    }
    
    Object.assign(state, update);
    
    // Recalculate total URLs if collectedUrls was updated
    if (update.collectedUrls) {
      partialRun.totalUrlsCollected = 
        Array.from(partialRun.paginationStates.values())
          .reduce((sum, s) => sum + s.collectedUrls.length, 0);
    }
    
    log.debug(`Updated pagination state for ${startPageUrl}`, update);
  }

  /**
   * Commit partial run to database
   */
  async commitPartialRun(siteId: string): Promise<ScrapeRun> {
    const partialRun = this.partialRuns.get(siteId);
    if (!partialRun || partialRun.committedToDb) {
      throw new Error(`No partial run to commit for site ${siteId}`);
    }
    
    // Check if ANY pagination returned 0 URLs
    const hasEmptyPagination = Array.from(partialRun.paginationStates.values())
      .some(s => s.completed && s.collectedUrls.length === 0);
    
    if (hasEmptyPagination) {
      throw new Error('Pagination returned 0 URLs - aborting entire run');
    }
    
    // Check if all paginations completed successfully
    const allCompleted = Array.from(partialRun.paginationStates.values())
      .every(s => s.completed && s.collectedUrls.length > 0);
    
    if (!allCompleted) {
      throw new Error('Not all paginations completed successfully');
    }
    
    // Only if ALL paginations succeeded with URLs
    const allUrls = Array.from(partialRun.paginationStates.values())
      .flatMap(s => s.collectedUrls);
    
    // Create scrape run via driver - only succeeds if no exceptions
    const run = await this.createRun(partialRun.siteId, allUrls);
    
    partialRun.committedToDb = true;
    this.partialRuns.delete(siteId); // Clear ONLY after successful DB write
    
    log.normal(`Committed partial run for ${run.domain} with ${allUrls.length} URLs`);
    return run;
  }

  /**
   * Check if a partial run exists for a site
   */
  hasPartialRun(siteId: string): boolean {
    return this.partialRuns.has(siteId);
  }

  /**
   * Get all sites with partial runs in progress
   */
  getSitesWithPartialRuns(options?: { forceRefresh?: boolean }): string[] {
    if (options?.forceRefresh) {
      // For forceRefresh, we don't have a database source for partial runs
      // as they're only tracked in-memory. Return current in-memory state.
      log.debug('forceRefresh requested for partial runs (in-memory only)');
    }
    return Array.from(this.partialRuns.keys());
  }

  // ========== Proxy Blocklist Management ==========

  /**
   * Check if a proxy is a datacenter proxy
   */
  private isDatacenterProxy(proxy: string): boolean {
    // Datacenter proxies typically have a specific format or identifier
    // This is a simplified check - adjust based on your proxy format
    return !proxy.includes('residential');
  }

  /**
   * Get cooldown period for a domain from proxy configuration
   */
  private async getProxyCooldownMinutes(domain: string): Promise<number> {
    try {
      const strategy = await getProxyStrategy(domain);
      return strategy.cooldownMinutes || 30; // Default 30 min
    } catch (error) {
      log.debug(`Failed to get proxy strategy for ${domain}, using default cooldown`);
      return 30;
    }
  }

  /**
   * Add proxy to blocklist (datacenter only)
   */
  async addProxyToBlocklist(domain: string, proxy: string, error: string): Promise<void> {
    const site = this.getSite(domain);
    if (!site || !this.isDatacenterProxy(proxy)) return;
    
    const existing = site.proxyBlocklist.get(proxy);
    if (existing) {
      existing.failureCount++;
      existing.failedAt = new Date();
      existing.lastError = error;
    } else {
      site.proxyBlocklist.set(proxy, {
        proxy,
        failedAt: new Date(),
        failureCount: 1,
        lastError: error
      });
    }
    
    log.debug(`Added proxy ${proxy} to blocklist for ${domain}`, { error });
  }

  /**
   * Add a proxy to blocklist by proxy object (for engines)
   * @param domain - The domain
   * @param proxy - The proxy object with id field
   * @param error - The error message
   */
  async addBlockedProxy(domain: string, proxy: Proxy, error: string = 'Network error'): Promise<void> {
    // Use the proxy ID as the blocklist key
    await this.addProxyToBlocklist(domain, proxy.id, error);
    log.normal(`Blocked proxy ${proxy.id} for ${domain} after repeated failures`);
  }

  /**
   * Get blocked proxies and clean up expired entries
   */
  async getBlockedProxies(domain: string, options?: { forceRefresh?: boolean }): Promise<string[]> {
    const site = this.getSite(domain);
    if (!site) return [];
    
    if (options?.forceRefresh) {
      // For forceRefresh, we don't have a database source for blocked proxies
      // as they're only tracked in-memory. Log for visibility.
      log.debug(`forceRefresh requested for blocked proxies of ${domain} (in-memory only)`);
    }
    
    const now = new Date();
    const cooldownMinutes = await this.getProxyCooldownMinutes(domain);
    const blocked: string[] = [];
    
    // Check each entry and remove if past cooldown
    for (const [proxy, entry] of site.proxyBlocklist) {
      const minutesSinceFailure = (now.getTime() - entry.failedAt.getTime()) / (1000 * 60);
      if (minutesSinceFailure >= cooldownMinutes) {
        // Remove from blocklist entirely
        site.proxyBlocklist.delete(proxy);
        log.debug(`Removed proxy ${proxy} from blocklist for ${domain} (cooldown expired)`);
      } else {
        blocked.push(proxy);
      }
    }
    
    return blocked;
  }

  /**
   * Get status for a specific site
   */
  async getSiteStatus(domain: string, options?: { forceRefresh?: boolean }): Promise<{
    hasActiveRun: boolean;
    hasPartialRun: boolean;
    blockedProxyCount: number;
  }> {
    if (options?.forceRefresh) {
      // Query database for active runs
      const activeRuns = await getActiveRuns();
      const hasActiveRun = activeRuns.some(run => run.domain === domain);
      
      // Partial runs are in-memory only
      const hasPartialRun = this.hasPartialRun(domain);
      
      // Get blocked proxies
      const blockedProxies = await this.getBlockedProxies(domain);
      
      return {
        hasActiveRun,
        hasPartialRun,
        blockedProxyCount: blockedProxies.length
      };
    }
    
    // Use in-memory state
    const site = this.getSite(domain);
    const hasActiveRun = !!(site?.activeRun && 
      (site.activeRun.status === 'pending' || site.activeRun.status === 'processing'));
    const hasPartialRun = this.hasPartialRun(domain);
    const blockedProxies = await this.getBlockedProxies(domain);
    
    return {
      hasActiveRun,
      hasPartialRun,
      blockedProxyCount: blockedProxies.length
    };
  }

}