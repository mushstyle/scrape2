import type { Page } from 'playwright';
import { Item, Image, Size } from '../db/types.js';

// Re-export Item and Image so they are available to scrapers importing from ./types.js
export type { Item, Image, Size };

// Standardized intermediate types for scraping
export type ScrapedImage = Omit<Image, 'mushUrl'>;
export type ScrapedItemData = Omit<Item, 'images' | 'status'> & {
  images: ScrapedImage[];
};

export interface Scraper {
  /**
   * Attempts to advance pagination (e.g., navigate to the next page, scroll, click 'load more').
   * Does NOT return URLs.
   * @param page Playwright page object
   * @returns `true` if pagination likely advanced and more content might exist, `false` otherwise (e.g., end reached, error).
   */
  paginate: (page: Page) => Promise<boolean>;

  /**
   * Gets all product URLs from the *current* page state.
   * Does NOT advance pagination.
   * @param page Playwright page object
   * @returns Set of product URLs found on the current page.
   */
  getItemUrls: (page: Page) => Promise<Set<string>>;

  /**
   * Scrapes item details from a given product URL.
   * The page is expected to be already navigated to the product's URL by the caller.
   * @param page Playwright page object, already navigated to the product page.
   * @param options Optional configuration for scraping behavior.
   * @returns A promise that resolves to the scraped Item data.
   */
  scrapeItem: (page: Page, options?: { 
    scrapeImages?: boolean;
    existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
    uploadToS3?: boolean;
  }) => Promise<Item>;
}