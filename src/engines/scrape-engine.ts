import { logger } from '../utils/logger.js';
import { SessionManager } from '../services/session-manager.js';
import { SiteManager } from '../services/site-manager.js';
import { itemsToSessions } from '../core/distributor.js';
import type { SiteConfig } from '../types/site-config-types.js';
import type { ScrapeTarget } from '../types/scrape-target.js';
import type { SessionInfo, SiteConfigWithBlockedProxies, UrlSessionPair } from '../core/distributor.js';

const log = logger.createContext('engine');

export interface EngineOptions {
  provider?: 'browserbase' | 'local';
  since?: string; // Relative time like '4d', '48h', '30m'
  instanceLimit?: number;
}

interface UrlWithDomain {
  url: string;
  domain: string;
}

export class Engine {
  private sessionManager: SessionManager;
  private siteManager: SiteManager;
  private provider: 'browserbase' | 'local';
  private since: Date;
  private instanceLimit: number;

  constructor(options: EngineOptions = {}) {
    this.provider = options.provider || 'browserbase';
    this.since = this.parseRelativeTime(options.since || '4d');
    this.instanceLimit = options.instanceLimit || 10;

    log.normal(`Initializing engine with provider: ${this.provider}, since: ${this.since.toISOString()}, instanceLimit: ${this.instanceLimit}`);

    this.sessionManager = new SessionManager({ 
      sessionLimit: this.instanceLimit,
      provider: this.provider 
    });
    
    this.siteManager = new SiteManager();
  }

  /**
   * Parse relative time strings like "7d", "48h", "30m"
   */
  private parseRelativeTime(timeStr: string): Date {
    const match = timeStr.match(/^(\d+)([dhm])$/);
    if (!match) {
      throw new Error(`Invalid time format: ${timeStr}. Use format like "7d", "48h", "30m"`);
    }

    const [, amount, unit] = match;
    const now = new Date();
    const value = parseInt(amount, 10);

    switch (unit) {
      case 'd':
        return new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
      case 'h':
        return new Date(now.getTime() - value * 60 * 60 * 1000);
      case 'm':
        return new Date(now.getTime() - value * 60 * 1000);
      default:
        throw new Error(`Unsupported time unit: ${unit}`);
    }
  }

  /**
   * Extract domain from URL
   */
  private extractDomain(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace(/^www\./, '');
    } catch (error) {
      log.debug(`Failed to parse URL: ${url}`);
      return '';
    }
  }

  /**
   * Get start pages from all sites respecting sessionLimit
   */
  private async getStartPages(): Promise<UrlWithDomain[]> {
    log.normal('Fetching start pages from all sites...');
    
    // Load sites if not already loaded
    if (!this.siteManager.isLoaded()) {
      await this.siteManager.loadSites();
    }
    
    // Get all start pages respecting sessionLimit
    return this.siteManager.getAllStartPages();
  }

  /**
   * Get items from scrape runs respecting sessionLimit
   */
  private async getScrapeRunItems(): Promise<UrlWithDomain[]> {
    log.normal(`Fetching items from scrape runs since ${this.since.toISOString()}...`);
    
    const scrapeRunsResponse = await this.siteManager.listRuns({ since: this.since });
    const allRuns = scrapeRunsResponse.runs || [];
    
    const urls: UrlWithDomain[] = [];
    
    // Get most recent run per domain
    const runsByDomain = new Map();
    for (const run of allRuns) {
      const existing = runsByDomain.get(run.domain);
      if (!existing || new Date(run.createdAt) > new Date(existing.createdAt)) {
        runsByDomain.set(run.domain, run);
      }
    }

    // Use SiteManager to get site configs instead of calling driver directly
    const validDomainConfigs = new Map<string, SiteConfig>();
    for (const domain of runsByDomain.keys()) {
      const config = this.siteManager.getSiteConfig(domain);
      if (config) {
        validDomainConfigs.set(domain, config);
      }
    }

    for (const [domain, run] of runsByDomain) {
      const config = validDomainConfigs.get(domain);
      if (!config) continue;

      const sessionLimit = config.proxy?.sessionLimit || 1;
      const items = run.items || [];
      const itemUrls = items.map((item: any) => item.url).filter(Boolean);
      const selectedUrls = itemUrls.slice(0, sessionLimit);
      
      for (const url of selectedUrls) {
        urls.push({
          url,
          domain
        });
      }
    }

    return urls;
  }

  /**
   * Run double-pass matcher algorithm
   */
  private async runDoubleMatcher(urls: UrlWithDomain[], siteConfigs: SiteConfigWithBlockedProxies[]): Promise<UrlSessionPair[]> {
    // Convert URLs to ScrapeTarget format
    const scrapeTargets: ScrapeTarget[] = urls.map(({ url }) => ({
      url,
      done: false,
      failed: false,
      invalid: false
    }));

    // Step 1: Get existing sessions
    const existingSessions = await this.sessionManager.getActiveSessions();
    const sessionInfos = this.sessionsToSessionInfo(existingSessions);
    
    log.normal(`Found ${existingSessions.length} existing sessions`);
    
    // Step 2: First pass
    let matched = itemsToSessions(scrapeTargets, sessionInfos, siteConfigs);
    log.normal(`First pass matched: ${matched.length} URL-session pairs`);
    
    // Find excess sessions
    const usedSessionIds = new Set(matched.map(pair => pair.sessionId));
    const excessSessions = sessionInfos.filter(session => !usedSessionIds.has(session.id));
    
    // Step 3: Session allocation
    if (excessSessions.length > 0) {
      log.normal(`Terminating ${excessSessions.length} excess sessions...`);
      for (const session of excessSessions) {
        try {
          await this.sessionManager.destroySession(session.id);
        } catch (error) {
          log.debug(`Failed to terminate session ${session.id}:`, error);
        }
      }
    }
    
    // Check if we need more sessions
    const sessionsNeeded = Math.min(this.instanceLimit - matched.length, scrapeTargets.length - matched.length);
    
    if (sessionsNeeded > 0) {
      log.normal(`Creating ${sessionsNeeded} new sessions...`);
      const newSessionIds: string[] = [];
      
      // Create sessions one by one
      for (let i = 0; i < sessionsNeeded; i++) {
        try {
          const sessionId = await this.sessionManager.createSession();
          newSessionIds.push(sessionId);
        } catch (error) {
          log.debug(`Failed to create session ${i + 1}/${sessionsNeeded}:`, error);
          break;
        }
      }
      
      if (newSessionIds.length > 0) {
        // Step 4: Second pass
        log.normal('Running second pass...');
        const allSessions = await this.sessionManager.getActiveSessions();
        const allSessionInfos = this.sessionsToSessionInfo(allSessions);
        matched = itemsToSessions(scrapeTargets, allSessionInfos, siteConfigs);
        log.normal(`Second pass matched: ${matched.length} URL-session pairs`);
      }
    }
    
    return matched;
  }

  /**
   * Convert Sessions to SessionInfo format
   */
  private sessionsToSessionInfo(sessions: any[]): SessionInfo[] {
    return sessions.map(session => {
      return {
        id: session.id,
        proxyType: session.proxyType || (this.provider === 'browserbase' ? 'datacenter' : 'none'),
        proxyId: session.proxyId,
        proxyGeo: session.proxyGeo || (this.provider === 'browserbase' ? 'US' : undefined)
      };
    });
  }

  /**
   * Paginate loop - processes start pages
   */
  async paginateLoop(): Promise<void> {
    log.normal('\n=== PAGINATE LOOP ===');
    
    try {
      // Get start pages respecting sessionLimit
      const urlsWithDomains = await this.getStartPages();
      log.normal(`Found ${urlsWithDomains.length} start pages to process`);
      
      if (urlsWithDomains.length === 0) {
        log.normal('No start pages found');
        return;
      }
      
      // Get site configs from SiteManager
      const validConfigs = this.siteManager.getSiteConfigs() as SiteConfigWithBlockedProxies[];
      
      // Run double-pass matcher
      const matched = await this.runDoubleMatcher(urlsWithDomains, validConfigs);
      
      // Print URLs that would be scraped
      log.normal(`\nURLs to scrape (${matched.length} total):`);
      matched.forEach((pair, index) => {
        const domain = this.extractDomain(pair.url);
        log.normal(`  ${(index + 1).toString().padStart(3)}: ${domain} → ${pair.url}`);
      });
      
      log.normal('\nPaginate loop completed (first run only)');
      
    } catch (error) {
      log.error('Paginate loop failed:', error);
      throw error;
    }
  }

  /**
   * Item loop - processes scrape run items
   */
  async itemLoop(): Promise<void> {
    log.normal('\n=== ITEM LOOP ===');
    
    try {
      // Get items respecting sessionLimit
      const urlsWithDomains = await this.getScrapeRunItems();
      log.normal(`Found ${urlsWithDomains.length} items to process`);
      
      if (urlsWithDomains.length === 0) {
        log.normal('No items found');
        return;
      }
      
      // Get site configs from SiteManager
      const validConfigs = this.siteManager.getSiteConfigs() as SiteConfigWithBlockedProxies[];
      
      // Run double-pass matcher
      const matched = await this.runDoubleMatcher(urlsWithDomains, validConfigs);
      
      // Print URLs that would be scraped
      log.normal(`\nURLs to scrape (${matched.length} total):`);
      matched.forEach((pair, index) => {
        const domain = this.extractDomain(pair.url);
        log.normal(`  ${(index + 1).toString().padStart(3)}: ${domain} → ${pair.url}`);
      });
      
      log.normal('\nItem loop completed (first run only)');
      
    } catch (error) {
      log.error('Item loop failed:', error);
      throw error;
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    log.normal('Cleaning up engine resources...');
    
    // Destroy all active sessions
    const activeSessions = await this.sessionManager.getActiveSessions();
    for (const session of activeSessions) {
      try {
        await this.sessionManager.destroySession(session.id);
      } catch (error) {
        log.debug(`Failed to destroy session ${session.id}:`, error);
      }
    }
    
    log.normal('Engine cleanup completed');
  }
}