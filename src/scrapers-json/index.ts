import type { JsonScraper } from '../types/json-scraper.js';
import example from './example.js';
import shopDiesel from './shop.diesel.com.js';

const scrapers: Record<string, JsonScraper> = {
  'example.com': example,
  'shop.diesel.com': shopDiesel,
};

export function getJsonScraper(domain: string, scraperName?: string): JsonScraper | undefined {
  // If scraperName is provided, try to load it dynamically
  if (scraperName) {
    try {
      // Remove .ts/.js extension if present
      const cleanName = scraperName.replace(/\.(ts|js)$/, '');
      // Try to find in the scrapers object first
      if (scrapers[cleanName]) {
        return scrapers[cleanName];
      }
      // For now, we can't dynamically import, so we just log a warning
      // In the future, we could add dynamic imports here
      console.warn(`Scraper ${scraperName} not found in index for domain ${domain}`);
    } catch (error) {
      console.error(`Error loading scraper ${scraperName} for domain ${domain}:`, error);
    }
  }
  
  // Fall back to domain-based lookup
  return scrapers[domain];
}

export function getAllJsonScrapers(): Record<string, JsonScraper> {
  return scrapers;
}

export { type JsonScraper } from '../types/json-scraper.js';