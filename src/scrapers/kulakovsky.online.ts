import type { Page } from 'playwright';
import type { Item, Image, Size } from '../types/item.js';
import * as Utils from "../db/db-utils.js";
// Site config is now managed by SiteManager service
import type { Scraper } from './types.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('kulakovsky.online');

/**
 * This file follows the page-pagination template to scrape kulakovsky.online
 */

export const SELECTORS = {
  productGrid: '.collection-grid__item', // Updated to match new structure
  productLinks: 'product-card a[href*="/products/"]', // Updated to match new product card structure
  pagination: {
    type: 'load-more' as const,
    loadMoreSelector: 'button#load-more, button.load-more-button'
  },
  product: {
    title: 'h1.product-title',
    price: '.price-list .money, .price-list sale-price .money', // Updated to include sale-price element
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
 * Paginates by clicking the "Load more" button until it's no longer visible.
 * @param page Playwright page object
 * @returns `true` if more items were loaded, `false` if no more items to load.
 */
export async function paginate(page: Page): Promise<boolean> {
  try {
    // Look for the load more button
    const loadMoreButton = await page.$('button#load-more, button.load-more-button');
    
    if (!loadMoreButton) {
      log.debug('   No load more button found - pagination ended');
      return false;
    }
    
    // Check if the button is visible
    const isVisible = await loadMoreButton.isVisible();
    if (!isVisible) {
      log.debug('   Load more button exists but is not visible - pagination ended');
      return false;
    }
    
    log.normal('   Clicking load more button...');
    
    // Click the button and wait for content to load
    await loadMoreButton.click();
    
    // Wait for domcontentloaded to ensure new products are loaded
    await page.waitForLoadState('domcontentloaded');
    
    // Wait longer for all dynamic content and the button to re-render
    await page.waitForTimeout(4000);
    
    // Check if button is still there and visible for next iteration
    const buttonStillExists = await page.$('button#load-more, button.load-more-button');
    if (!buttonStillExists) {
      return false;
    }
    
    const buttonStillVisible = await buttonStillExists.isVisible();
    return buttonStillVisible;
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.debug(`   Pagination error: ${errorMessage}`);
    return false;
  }
}

function extractSizes(page: Page): Promise<Array<{ size: string; is_available: boolean }>> {
  return page.evaluate(() => {
    const labels = document.querySelectorAll('fieldset.variant-picker__option label.block-swatch');
    // Find size labels specifically (not color swatches)
    return Array.from(labels)
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
  return page.evaluate(() => {
    const label = document.querySelector('fieldset.variant-picker__option input[type="radio"][checked] + label.color-swatch');
    if (!label) return '';
    // Get the color name from the span inside the label
    const colorSpan = label.querySelector('.sr-only');
    return colorSpan?.textContent?.trim() || '';
  }).catch(() => ''); // Return empty string on error
}

function extractImages(page: Page): Promise<Array<{ sourceUrl: string; alt_text: string }>> {
  return page.evaluate((selector) => {
    const imgs = document.querySelectorAll(selector);
    return Array.from(imgs).map(img => {
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
  }, SELECTORS.product.images).catch(() => []); // Add catch for robustness
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
    
    // Wait a bit for dynamic content to load
    await page.waitForTimeout(2000);
    
    // Wait for price to be ready (has 'done' class)
    await page.waitForSelector('.price-list .money.done', { timeout: 10000 }).catch(() => {
      // If price doesn't have 'done' class, just continue
      log.debug('Price may not be fully loaded (no .done class)');
    });

    const title = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      return el?.textContent?.trim() || '';
    }, SELECTORS.product.title);

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
      // Use evaluate to extract price data from all potential price elements
      const priceData = await page.evaluate((selector) => {
        // Find all money elements
        const elements = document.querySelectorAll(selector);
        if (elements.length === 0) return null;
        
        // Try different price containers
        let priceEl = null;
        
        // First try sale-price element
        priceEl = document.querySelector('sale-price .money');
        if (!priceEl) {
          // Fallback to regular price
          priceEl = document.querySelector('.price-list .money');
        }
        
        if (!priceEl) return null;
        
        return {
          text: priceEl.textContent?.trim() || '0',
          wsPrice: priceEl.getAttribute('ws-price'),
          wsCurrency: priceEl.getAttribute('ws-currency'),
          isDone: priceEl.classList.contains('done')
        };
      }, SELECTORS.product.price);

      if (priceData) {
        log.debug(`Price data found - text: "${priceData.text}", ws-price: "${priceData.wsPrice}", ws-currency: "${priceData.wsCurrency}", isDone: ${priceData.isDone}`);
        const text = priceData.text;
        
        // Check for ws-price attribute first (if present)
        if (priceData.wsPrice) {
          // ws-price - use it directly
          price = parseInt(priceData.wsPrice, 10) || 0;
          
          // Determine currency from ws-currency or text
          if (priceData.wsCurrency) {
            currency = priceData.wsCurrency;
          } else if (text.includes('$')) {
            currency = 'USD';
          } else if (text.includes('₴')) {
            currency = 'UAH';
          }
          log.debug(`Using ws-price: ${price} ${currency}`);
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
            log.debug(`Parsed price from text: ${price} ${currency}`);
          } else {
            // Other format handling...
            const numericText = text.replace(/[^\d]/g, '');
            price = parseInt(numericText, 10) || 0;
            log.debug(`Parsed price (fallback): ${price}`);
          }
        }
      } else {
        log.debug('No price data found from selectors');
      }
    } catch (e) { log.error(`Error parsing price: ${e}`); }

    const description = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      return el?.textContent?.trim() || '';
    }, SELECTORS.product.description).catch(() => '');

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