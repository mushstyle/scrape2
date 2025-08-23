import type { Item } from '../types/item.js';

export interface JsonScraper {
  domain: string;
  scrapeItem(json: unknown): Item;
}