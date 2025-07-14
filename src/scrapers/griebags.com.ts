import { /* chromium, */ Page } from 'playwright';
// import type { Item, Scraper } from './types.js'; // Corrected import below
import type { Scraper } from './types.js';
import type { Item, Image } from '../types/item.js'; // Direct import for Item and Image
import * as Utils from '../db/db-utils.js';
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js';
import { logger } from '../lib/logger.js';

const log = logger.createContext('griebags.com');

// Local helper function to parse prices
const parsePrice = (text: string | null | undefined): number | undefined => {
  if (!text) {
    return undefined;
  }
  try {
    // Remove currency symbol (and its dot), whitespace, and commas
    const cleanedText = text
      .replace(/грн\.?/, '') // Remove "грн" or "грн."
      .replace(/[\s,]/g, ''); // Remove whitespace and commas
    return parseFloat(cleanedText); // Should parse "18394"
  } catch (error) {
    log.error(`Error parsing price: ${text}`, error);
    return undefined;
  }
};

export async function getItemUrls(page: Page): Promise<Set<string>> {
  const urls = new Set<string>();
  await page.waitForSelector('ul.products li.product a.woocommerce-LoopProduct-link');
  const links = await page.locator('ul.products li.product a.woocommerce-LoopProduct-link').all();

  for (const link of links) {
    const href = await link.getAttribute('href');
    if (href) {
      try {
        // Resolve URL to absolute path
        const absoluteUrl = new URL(href, page.url()).href;
        urls.add(absoluteUrl);
      } catch (e) {
        log.error(`Invalid URL found on ${page.url()}: ${href}`);
      }
    }
  }
  return urls;
}

export async function paginate(page: Page): Promise<boolean> {
  // All items are on one page, no pagination needed.
  return false;
}

export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  const sourceUrl = page.url();
  try {
    // Page is already at sourceUrl. Ensure content is loaded by caller if necessary.
    // await page.goto(sourceUrl, { waitUntil: 'domcontentloaded' }); // Removed goto

    // Wait for main content to ensure dynamic content is loaded
    await page.waitForSelector('.product-summary');

    const rawDetails = await page.evaluate(() => {
      const title = document.querySelector('h1.product_title')?.textContent?.trim() || '';
      const sku = document.querySelector('.sku_wrapper span.sku')?.textContent?.trim() || null;

      const descriptionElement = document.querySelector('#tab-description .container');
      const description = descriptionElement ? Array.from(descriptionElement.querySelectorAll('p')).map(p => p.textContent?.trim()).filter(Boolean).join('\n\n') : '';

      const priceElement = document.querySelector('p.price');
      const originalPriceText = priceElement?.querySelector('del span.woocommerce-Price-amount bdi')?.textContent || null;
      const salePriceText = priceElement?.querySelector('ins span.woocommerce-Price-amount bdi')?.textContent || null;
      const currentPriceText = priceElement?.querySelector('span.woocommerce-Price-amount bdi')?.textContent || null; // Fallback if no del/ins
      const currencySymbol = priceElement?.querySelector('span.woocommerce-Price-currencySymbol')?.textContent?.trim() || 'UAH'; // Default to UAH based on examples

      const imageElements = document.querySelectorAll('.woocommerce-product-gallery__slider .woocommerce-product-gallery__image a');
      const images = Array.from(imageElements).map(a => {
        const href = a.getAttribute('href');
        const img = a.querySelector('img');
        const alt = img?.getAttribute('alt') || title; // Use title as fallback alt text
        return href ? { sourceUrl: href, alt: alt || '' } : null;
      }).filter(img => img !== null) as { sourceUrl: string, alt: string }[];

      return {
        title,
        sku,
        description,
        originalPriceText,
        salePriceText,
        currentPriceText,
        currencySymbol,
        images
      };
    });

    // --- Back in Node.js context: Parse and process RAW data ---
    let price: number | undefined;
    let sale_price: number | undefined;
    let currency = 'UAH'; // Default based on site

    if (rawDetails.originalPriceText && rawDetails.salePriceText) {
      price = parsePrice(rawDetails.originalPriceText);
      sale_price = parsePrice(rawDetails.salePriceText);
    } else if (rawDetails.currentPriceText) {
      // If no <del>, use currentPriceText as the main price
      price = parsePrice(rawDetails.currentPriceText);
      sale_price = undefined; // Not on sale or original price not found
    }

    if (rawDetails.currencySymbol === 'грн.') {
      currency = 'UAH';
    } // Add other currency mappings if needed

    // Basic validation
    if (!rawDetails.title || price === undefined) {
      throw new Error(`Skipping item due to missing title or price: ${sourceUrl}`);
    }

    // Image handling with existing images support
    let uploadedImages: Image[];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
      log.normal(`Using ${options.existingImages.length} existing images from database`);
      uploadedImages = options.existingImages.map(img => ({
        sourceUrl: img.sourceUrl,
        mushUrl: img.mushUrl,
        alt_text: undefined
      }));
    } else {
      if (options?.uploadToS3 !== false) {

        uploadedImages = await uploadImagesToS3AndAddUrls(rawDetails.images, 'griebags.com');

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        uploadedImages = rawDetails.images;

      }
    }

    const item: Item = {
      sourceUrl,
      title: rawDetails.title,
      price: price ?? 0, // price is validated above, so ?? 0 is just for type safety
      sale_price,
      currency,
      description: rawDetails.description,
      product_id: rawDetails.sku || sourceUrl,
      images: uploadedImages,
    };

    return Utils.formatItem(item);
  } catch (error) {
    log.error(`Error scraping item ${sourceUrl}:`, error);
    throw new Error(`Error scraping item ${sourceUrl}: ${error}`);
  } finally {
    // await browser.close(); // Browser lifecycle managed by the caller
  }
}

const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper; 