import type { Item } from './item.js';

export interface JsonScraper {
  domain: string;
  scrapeItem(json: unknown, options?: { uploadToS3?: boolean }): Promise<Item>;
}