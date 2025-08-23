import type { JsonScraper } from './types.js';
import example from './example.js';

const scrapers: Record<string, JsonScraper> = {
  'example.com': example,
};

export function getJsonScraper(domain: string): JsonScraper | undefined {
  return scrapers[domain];
}

export function getAllJsonScrapers(): Record<string, JsonScraper> {
  return scrapers;
}

export { type JsonScraper } from './types.js';