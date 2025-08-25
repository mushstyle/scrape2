import { logger } from '../utils/logger.js';
import type { Scraper } from '../scrapers/types.js';
import { getSiteConfig } from './site-config.js';

const log = logger.createContext('scraper-loader');

/**
 * Driver for loading scrapers dynamically
 * This provides an abstraction over the scraper file loading mechanism
 */

/**
 * Load a scraper module for a given domain
 * @param domain The domain to load the scraper for (e.g., 'amgbrand.com')
 * @returns The scraper module
 * @throws Error if the domain has a JSON scraper (not supported for browser automation)
 */
export async function loadScraper(domain: string): Promise<Scraper> {
  try {
    // Check if this domain has a JSON scraper instead of HTML scraper
    try {
      const siteConfig = await getSiteConfig(domain);
      if (siteConfig.scraperType === 'json') {
        throw new Error(`Domain ${domain} uses a JSON scraper, which is not supported for browser-based scraping. Use 'npm run verify:item:json' for JSON data processing.`);
      }
    } catch (configError) {
      // If we can't get config, continue with trying to load the scraper
      log.debug(`Could not fetch site config for ${domain}, attempting to load HTML scraper anyway`);
    }
    
    // Dynamically import the scraper module
    const scraperPath = `../scrapers/${domain}.js`;
    const scraperModule = await import(scraperPath);
    
    // Check if the module has a default export
    if (!scraperModule.default) {
      throw new Error(`Scraper for ${domain} does not have a default export`);
    }
    
    // Validate the scraper has required methods
    const scraper = scraperModule.default as Scraper;
    if (!scraper.paginate || !scraper.getItemUrls || !scraper.scrapeItem) {
      throw new Error(`Scraper for ${domain} does not implement required methods`);
    }
    
    log.debug(`Successfully loaded scraper for ${domain}`);
    return scraper;
  } catch (error) {
    log.error(`Failed to load scraper for domain ${domain}:`, error);
    throw new Error(`Failed to load scraper for domain ${domain}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Check if a scraper exists for a given domain
 * @param domain The domain to check
 * @returns true if scraper exists, false otherwise
 */
export async function scraperExists(domain: string): Promise<boolean> {
  try {
    await loadScraper(domain);
    return true;
  } catch {
    return false;
  }
}