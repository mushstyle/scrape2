/**
 * VerifyItemEngine
 * 
 * Core engine for verifying item scraping functionality.
 * Scrapes a single item URL using the appropriate scraper.
 * Designed to be callable from CLI scripts or API endpoints.
 */

import { SessionManager } from '../services/session-manager.js';
import { SiteManager } from '../services/site-manager.js';
import { createBrowserFromSession } from '../drivers/browser.js';
import { logger } from '../utils/logger.js';
import { loadScraper } from '../drivers/scraper-loader.js';
import { extractDomain } from '../utils/url-utils.js';
import { RequestCache } from '../drivers/cache.js';

const log = logger.createContext('verify-item-engine');

export interface VerifyItemOptions {
  url: string;
  sessionManager?: SessionManager;
  siteManager?: SiteManager;
  localHeadless?: boolean;
  localHeaded?: boolean;
  sessionTimeout?: number;  // Session timeout in seconds
  noProxy?: boolean;  // Disable proxy usage regardless of site configuration
}

export interface VerifyItemResult {
  success: boolean;
  url: string;
  domain: string;
  item: any | null;
  error?: string;
  duration: number;
  scraperFields?: string[];
}

export class VerifyItemEngine {
  private sessionManager: SessionManager;
  private siteManager: SiteManager;
  
  constructor(options: Partial<VerifyItemOptions> = {}) {
    // Determine provider based on browser flags
    const provider = (options.localHeaded || options.localHeadless) ? 'local' : 'browserbase';
    
    this.sessionManager = options.sessionManager || new SessionManager({ provider });
    this.siteManager = options.siteManager || new SiteManager();
  }
  
  async verify(options: VerifyItemOptions): Promise<VerifyItemResult> {
    const startTime = Date.now();
    let session = null;
    
    try {
      // Extract domain from URL
      const domain = extractDomain(options.url);
      if (!domain) {
        throw new Error(`Could not extract domain from URL: ${options.url}`);
      }
      
      log.normal(`URL: ${options.url}`);
      log.normal(`Domain: ${domain}`);
      
      // Initialize
      await this.siteManager.loadSites();
      const siteConfig = this.siteManager.getSiteConfig(domain);
      if (!siteConfig) {
        throw new Error(`No site config for ${domain}`);
      }
      
      // Load scraper
      const scraper = await loadScraper(domain);
      log.normal(`Loaded scraper for ${domain}`);
      
      // Get proxy for domain from SiteManager
      const proxy = options.noProxy ? null : await this.siteManager.getProxyForDomain(domain);
      
      // Create session
      const sessionOptions: any = { 
        domain,
        proxy 
      };
      
      // Add headless option based on flags
      if (options.localHeadless || options.localHeaded) {
        sessionOptions.headless = options.localHeadless ? true : (options.localHeaded ? false : true);
      }
      
      // Add timeout if specified
      if (options.sessionTimeout) {
        sessionOptions.timeout = options.sessionTimeout;
      }
      
      session = await this.sessionManager.createSession(sessionOptions);
      if (!session) {
        throw new Error('Failed to create session - no available slots');
      }
      const { browser, createContext } = await createBrowserFromSession(session);
      const context = await createContext();
      const page = await context.newPage();
      
      // Enable caching with image blocking for bandwidth savings
      const cache = new RequestCache({
        maxSizeBytes: 50 * 1024 * 1024, // 50MB for single page verification
        blockImages: true  // Block images by default
      });
      await cache.enableForPage(page);
      
      // Navigate to item URL
      log.normal(`Navigating to ${options.url}`);
      await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      
      // Scrape item
      log.normal('Scraping item...');
      const items = await scraper.scrapeItem(page);
      
      // Validate result
      if (items.length === 0) {
        throw new Error('Scraper returned empty array');
      }
      
      // For verify, use first item
      const item = items[0];
      
      // Log if multiple items returned (for debugging)
      if (items.length > 1) {
        log.normal(`Note: Scraper returned ${items.length} items, showing first item only`);
      }
      
      // Extract field names for debugging
      const scraperFields = Object.keys(item).filter(key => item[key] !== null && item[key] !== undefined);
      
      log.normal(`Successfully scraped item with ${scraperFields.length} fields`);
      
      // Cleanup
      await page.close();
      await context.close();
      await browser.close();
      await this.sessionManager.destroySessionByObject(session);
      
      return {
        success: true,
        url: options.url,
        domain,
        item,
        duration: Date.now() - startTime,
        scraperFields
      };
      
    } catch (error) {
      log.error(`Error scraping item: ${error.message}`);
      
      // Cleanup on error
      if (session) {
        await this.sessionManager.destroySessionByObject(session).catch(e => 
          log.debug(`Failed to cleanup session: ${e.message}`)
        );
      }
      
      return {
        success: false,
        url: options.url,
        domain: extractDomain(options.url) || 'unknown',
        item: null,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }
}