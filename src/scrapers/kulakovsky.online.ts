import type { Page } from 'playwright';
// import { chromium, Browser } from 'playwright'; // Removed Browser, chromium
import { Item, Image, Size } from "../db/types.js";
import * as Utils from "../db/db-utils.js";
import { getSiteConfig } from "../types/site-config.js";
import type { Scraper } from './types.js';
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js';
import { logger } from '../lib/logger.js';

const log = logger.createContext('kulakovsky.online');

/**
 * This file follows the page-pagination template to scrape kulakovsky.online
 */

export const SELECTORS = {
  productGrid: '.collection-grid__item', // Updated to match new structure
  productLinks: 'product-card a[href*="/products/"]', // Updated to match new product card structure
  pagination: {
  },
  product: {
    title: 'h1.product-title',
    price: '.price-list .money',
    images: '.product-gallery__media img',
    description: '.prose',
    productId: 'input[name="product-id"]',
    sizeWrapper: '.variant-picker__option fieldset', // Updated to match new structure
    colorWrapper: '.variant-picker__option fieldset' // Updated to match new structure
  }
};

/**
 * Gathers item URLs on the current page
 * @param page Playwright page object
 * @returns A set of product URLs
 */
export async function getItemUrls(page: Page): Promise<Set<string>> {
  try {
    await page.waitForSelector(SELECTORS.productLinks, { timeout: 10000 });
    const links = await page.$$eval(SELECTORS.productLinks, els =>
      els.map((el) => (el as HTMLAnchorElement).href || '').filter(Boolean)
    );
    return new Set(links);
  } catch (error) {
    log.debug(`Could not find product links (${SELECTORS.productLinks}) on ${page.url()}, returning empty set. Error: ${error}`);
    return new Set<string>();
  }
}

/**
 * Paginates by incrementing the page number in the URL.
 * Checks for page validity and "no products" message after navigation.
 * @param page Playwright page object
 * @returns `true` if pagination likely succeeded, `false` otherwise.
 */
export async function paginate(page: Page): Promise<boolean> {
  const currentUrl = page.url();
  const match = currentUrl.match(/page=(\d+)/);
  const currentPage = match ? parseInt(match[1], 10) : 1;
  const nextPage = currentPage + 1;

  // Build next URL
  let nextUrl: string;
  if (match) {
    nextUrl = currentUrl.replace(/page=\d+/, `page=${nextPage}`);
  } else {
    const separator = currentUrl.includes('?') ? '&' : '?';
    nextUrl = `${currentUrl}${separator}page=${nextPage}`;
  }

  log.debug(`   Navigating to next page: ${nextUrl}`);

  try {
    const response = await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });

    if (!response || !response.ok()) {
      log.debug(`   Pagination failed: Bad response for ${nextUrl} (Status: ${response?.status()})`);
      return false;
    }

    // Check if we landed on a page explicitly stating no products
    const noProductsMessage = await page.$('.grid__item p');
    if (noProductsMessage) {
      const text = await noProductsMessage.textContent();
      if (text?.includes('Sorry, there are no products in this collection')) {
        log.debug(`   Pagination ended: "No products" message found on ${nextUrl}`);
        return false;
      }
    }

    // Optional: Check if the product grid exists
    await page.waitForSelector(SELECTORS.productGrid, { timeout: 5000 });
    log.debug(`   Pagination successful to page ${nextPage}`);
    return true;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.debug(`   Pagination likely ended or failed: ${errorMessage}`);
    return false;
  }
}

function extractSizes(page: Page): Promise<Array<{ size: string; is_available: boolean }>> {
  return page.$$eval('fieldset.variant-picker__option label.block-swatch', (labels) => {
    // Find size labels specifically (not color swatches)
    return labels
      .filter(label => {
        const input = label.previousElementSibling as HTMLInputElement;
        return input && input.name && input.name.includes('option1'); // Size is typically option1
      })
      .map(label => {
        const input = label.previousElementSibling as HTMLInputElement;
        const sizeText = label.textContent?.trim() || '';
        // Check if the label has any disabled/unavailable class
        const isAvailable = !label.classList.contains('disabled') && !label.classList.contains('unavailable');
        return {
          size: sizeText,
          is_available: isAvailable
        };
      })
      .filter(item => item.size);
  }).catch(() => []); // Add catch for robustness
}

function extractColor(page: Page): Promise<string> {
  return page.$eval('fieldset.variant-picker__option input[type="radio"][checked] + label.color-swatch',
    label => {
      // Get the color name from the span inside the label
      const colorSpan = label.querySelector('.sr-only');
      return colorSpan?.textContent?.trim() || '';
    }
  ).catch(() => ''); // Return empty string on error
}

function extractImages(page: Page): Promise<Array<{ sourceUrl: string; alt_text: string }>> {
  return page.$$eval(SELECTORS.product.images, (imgs) => {
    return imgs.map(img => {
      // Get the highest quality src from srcset if available
      const srcset = img.getAttribute('srcset');
      let sourceUrl = img.getAttribute('src') || '';
      
      if (srcset) {
        // Parse srcset to get the highest resolution image
        const sources = srcset.split(',').map(s => s.trim());
        const lastSource = sources[sources.length - 1];
        if (lastSource) {
          sourceUrl = lastSource.split(' ')[0];
        }
      }
      
      return {
        sourceUrl: sourceUrl,
        alt_text: img.getAttribute('alt') || ''
      };
    })
      .filter(img => img.sourceUrl) // Keep only images with a URL
      // Correct protocol if needed
      .map(img => ({
        ...img,
        sourceUrl: img.sourceUrl.startsWith('//') ? 'https:' + img.sourceUrl : img.sourceUrl
      }))
      // Remove duplicates by URL (ignoring query params for comparison)
      .filter((img, index, self) => {
        const baseUrl = img.sourceUrl.split('?')[0];
        return index === self.findIndex(t => t.sourceUrl.split('?')[0] === baseUrl);
      });
  }).catch(() => []); // Add catch for robustness
}

/**
 * Scrapes item details from the provided URL
 * @param url The product URL
 * @returns A structured Item object
 */
export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  const sourceUrl = page.url();
  try {
    // Page is already at sourceUrl, ensure content is loaded.
    // Wait for the product info section which contains all the data we need
    await page.waitForSelector('.product-info', { timeout: 10000 });

    const title = await page.$eval(SELECTORS.product.title, el => el.textContent?.trim() || '');

    let product_id = 'unknown';
    try {
      const productIdEl = await page.$(SELECTORS.product.productId);
      if (productIdEl) {
        product_id = await productIdEl.getAttribute('value') || 'unknown';
      }
      if (product_id === 'unknown' || !product_id) {
        const urlParts = sourceUrl.split('/');
        const slug = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2];
        product_id = `kulakovsky-${slug || Date.now()}`;
      }
    } catch (e) {
      const urlParts = sourceUrl.split('/');
      const slug = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2];
      product_id = `kulakovsky-${slug || Date.now()}`;
    }

    let price = 0;
    let sale_price: number | undefined;
    let currency = 'EUR';
    try {
      // Use $$eval to avoid context errors with Browserbase
      const priceData = await page.$$eval(SELECTORS.product.price, (elements) => {
        if (elements.length === 0) return null;
        const el = elements[0];
        return {
          text: el.textContent?.trim() || '0',
          wsPrice: el.getAttribute('ws-price'),
          wsCurrency: el.getAttribute('ws-currency')
        };
      });

      if (priceData) {
        const text = priceData.text;
        
        // Check for ws-price attribute first (if present)
        if (priceData.wsPrice && priceData.wsCurrency === 'UAH') {
          // ws-price in UAH - use it directly
          price = parseInt(priceData.wsPrice, 10) || 0;
          currency = 'UAH';
        } else {
          // Parse displayed price text
          if (text.match(/[$€£₴][\d,]+\.?\d*/)) {
            // Extract currency symbol
            const currencyMatch = text.match(/[$€£₴]/);
            if (currencyMatch) {
              const currencySymbol = currencyMatch[0];
              currency = currencySymbol === '€' ? 'EUR' : 
                        currencySymbol === '$' ? 'USD' : 
                        currencySymbol === '£' ? 'GBP' :
                        currencySymbol === '₴' ? 'UAH' : 'EUR';
            }
            
            // Remove currency symbol and parse number
            const numericText = text.replace(/[^\d.,]/g, '').replace(/,/g, '');
            price = parseFloat(numericText) || 0;
          } else {
            // Other format handling...
            const numericText = text.replace(/[^\d]/g, '');
            price = parseInt(numericText, 10) || 0;
          }
        }
      }
    } catch (e) { log.error(`Error parsing price: ${e}`); }

    const description = await page.$eval(SELECTORS.product.description, el => el.textContent?.trim() || '').catch(() => '');

    // Get data concurrently
    const [sizes, color, imagesData] = await Promise.all([
      extractSizes(page),
      extractColor(page),
      extractImages(page) // This returns Omit<Image, 'mushUrl'>[]
    ]);

    // --- S3 Image Upload Step ---
    // Image handling with existing images support
    let imagesWithMushUrl: Image[];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
      log.debug(`Using ${options.existingImages.length} existing images from database`);
      imagesWithMushUrl = options.existingImages.map(img => ({
        sourceUrl: img.sourceUrl,
        mushUrl: img.mushUrl,
        alt_text: undefined
      }));
    } else {
      if (options?.uploadToS3 !== false) {

        imagesWithMushUrl = await uploadImagesToS3AndAddUrls(imagesData, sourceUrl);

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        imagesWithMushUrl = imagesData;

      }
    } // Use sourceUrl
    // --- End S3 Upload Step ---

    // Construct final Item
    const finalItem: Item = {
      sourceUrl: sourceUrl, // Use sourceUrl
      product_id,
      title,
      images: imagesWithMushUrl, // Use processed images
      price,
      sale_price,
      currency,
      description,
      color: color || undefined,
      sizes: sizes.length > 0 ? sizes : undefined,
      vendor: 'Kulakovsky',
      status: 'ACTIVE' // Assuming active
      // Add tags, type if needed
      // tags: [],
      // type: undefined,
    };

    return Utils.formatItem(finalItem);

  } catch (error) {
    log.error(`Error scraping item at ${sourceUrl}: ${error}`); // Use sourceUrl
    // Return minimal error item matching Item type
    return Utils.formatItem({
      sourceUrl: sourceUrl, // Use sourceUrl
      product_id: 'unknown',
      title: `Error scraping item`,
      description: error instanceof Error ? error.message : String(error),
      status: undefined,
      vendor: 'Kulakovsky',
      price: 0,
      currency: 'XXX',
      images: [],
      sizes: [],
      color: undefined,
      tags: [],
      type: undefined,
    });
  }
}

// Define the default export for the scraper
const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper;