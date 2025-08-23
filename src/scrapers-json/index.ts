import type { JsonScraper } from '../types/json-scraper.js';
import example from './example.js';
import shopDiesel from './shop.diesel.com.js';

const scrapers: Record<string, JsonScraper> = {
  'example.com': example,
  'shop.diesel.com': shopDiesel,
};

export function getJsonScraper(domain: string): JsonScraper | undefined {
  return scrapers[domain];
}

export function getAllJsonScrapers(): Record<string, JsonScraper> {
  return scrapers;
}

export { type JsonScraper } from '../types/json-scraper.js';