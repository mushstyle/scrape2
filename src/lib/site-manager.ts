import { logger } from './logger.js';
import { getSites } from '../providers/etl-api.js';
import { getSiteConfig } from '../providers/site-config.js';
import type { SiteConfig } from '../types/site-config-types.js';

const log = logger.createContext('site-manager');

export interface SiteState {
  domain: string;
  config: SiteConfig;
  lastScraped?: Date;
  activeSessionCount?: number;
  customData?: Record<string, any>;
}

export interface SiteManagerOptions {
  autoLoad?: boolean;
}

/**
 * Manages site configurations and state
 * Provides centralized access to site data with in-memory state tracking
 */
export class SiteManager {
  private sites: Map<string, SiteState> = new Map();
  private loaded: boolean = false;

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
    const allSites = sitesResponse.data || sitesResponse.sites || [];
    
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
          customData: {}
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
   * Get start pages for a domain, respecting sessionLimit
   */
  getStartPagesForDomain(domain: string): string[] {
    const site = this.getSite(domain);
    if (!site || !site.config.startPages) {
      return [];
    }

    const sessionLimit = site.config.proxy?.sessionLimit || 1;
    return site.config.startPages.slice(0, sessionLimit);
  }

  /**
   * Get all start pages from all sites, respecting sessionLimit
   */
  getAllStartPages(): Array<{ url: string; domain: string }> {
    const urls: Array<{ url: string; domain: string }> = [];

    for (const site of this.sites.values()) {
      const startPages = this.getStartPagesForDomain(site.domain);
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
   * Add or update a site manually
   */
  addSite(domain: string, config: SiteConfig, state?: Partial<SiteState>): void {
    const normalizedDomain = domain.replace(/^www\./, '');
    
    this.sites.set(normalizedDomain, {
      domain: normalizedDomain,
      config,
      lastScraped: state?.lastScraped,
      activeSessionCount: state?.activeSessionCount,
      customData: state?.customData || {}
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
}