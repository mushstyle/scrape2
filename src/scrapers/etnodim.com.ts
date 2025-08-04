import type { Page } from 'playwright';
import type { Item, Image, Size } from '../types/item.js';
import * as Utils from "../db/db-utils.js";
import type { Scraper } from './types.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('etnodim.com');

/**
 * Scraper for etnodim.com - all products are loaded on the page (no pagination needed)
 */

export const SELECTORS = {
  productGrid: '.catalog__case.js-product-item',
  productLinks: '.goods-case__title[href], .goods-case__image-slider[href]',
  pagination: {
    type: 'none' as const, // All products are on the page
  },
  product: {
    title: 'h1, .product__title',
    price: '.product__price .num, .goods-price__current .num',
    images: '.product__gallery img, .product-gallery img',
    description: '.product__description, .product-info__description',
    productId: '[data-product-id]',
    sizeWrapper: '.product__sizes, .goods-case__sizes',
    colorWrapper: '.product__colors'
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
      els.map((el) => {
        const href = (el as HTMLAnchorElement).href || el.getAttribute('href') || '';
        // Convert relative URLs to absolute
        if (href && !href.startsWith('http')) {
          const url = new URL(href, window.location.href);
          return url.href;
        }
        return href;
      }).filter(Boolean)
    );
    
    log.debug(`Found ${links.length} product links on page`);
    return new Set(links);
  } catch (error) {
    log.debug(`Could not find product links (${SELECTORS.productLinks}) on ${page.url()}, returning empty set. Error: ${error}`);
    return new Set<string>();
  }
}

/**
 * Pagination function - returns false as all products are on the page
 * @param page Playwright page object
 * @returns Always returns false (no pagination)
 */
export async function paginate(page: Page): Promise<boolean> {
  log.debug('No pagination needed - all products are on the page');
  return false;
}

/**
 * Scrapes item details from the provided URL
 * @param page Playwright page object
 * @returns A structured Item object
 */
export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item[]> {
  const sourceUrl = page.url();
  try {
    // Wait for product content to load
    await page.waitForSelector(SELECTORS.product.title, { timeout: 10000 });
    
    // Extract title
    const title = await page.$eval(SELECTORS.product.title, el => 
      el.textContent?.trim() || ''
    ).catch(() => '');

    // Extract product ID
    let product_id = 'unknown';
    try {
      const productIdEl = await page.$('[data-product-id]');
      if (productIdEl) {
        product_id = await productIdEl.getAttribute('data-product-id') || 'unknown';
      }
      if (product_id === 'unknown') {
        // Try to extract from URL
        const urlMatch = sourceUrl.match(/\/([^\/]+)$/);
        if (urlMatch && urlMatch[1]) {
          product_id = `etnodim-${urlMatch[1]}`;
        }
      }
    } catch (e) {
      const urlMatch = sourceUrl.match(/\/([^\/]+)$/);
      if (urlMatch && urlMatch[1]) {
        product_id = `etnodim-${urlMatch[1]}`;
      }
    }

    // Extract price
    let price = 0;
    let currency = 'USD'; // Default currency
    try {
      const priceText = await page.$eval(SELECTORS.product.price, el => 
        el.textContent?.trim() || '0'
      ).catch(() => '0');
      
      // Remove non-numeric characters except decimal point
      const numericPrice = priceText.replace(/[^\d.,]/g, '').replace(',', '.');
      price = parseFloat(numericPrice) || 0;
      
      // Try to detect currency
      const currencyEl = await page.$('.currency, .goods-price__currency');
      if (currencyEl) {
        const currencyText = await currencyEl.textContent();
        if (currencyText?.includes('$')) currency = 'USD';
        else if (currencyText?.includes('€')) currency = 'EUR';
        else if (currencyText?.includes('₴')) currency = 'UAH';
      }
    } catch (e) {
      log.debug(`Error parsing price: ${e}`);
    }

    // Extract description
    const description = await page.$eval(SELECTORS.product.description, el => 
      el.textContent?.trim() || ''
    ).catch(() => '');

    // Extract images
    const imagesData = await page.$$eval(SELECTORS.product.images, imgs =>
      imgs.map(img => {
        let sourceUrl = img.getAttribute('src') || img.getAttribute('data-src') || '';
        
        // Get higher resolution from srcset or data-srcset if available
        const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
        if (srcset) {
          const sources = srcset.split(',').map(s => s.trim());
          const highRes = sources[sources.length - 1];
          if (highRes) {
            sourceUrl = highRes.split(' ')[0];
          }
        }
        
        // Convert relative URLs to absolute
        if (sourceUrl && !sourceUrl.startsWith('http')) {
          if (sourceUrl.startsWith('//')) {
            sourceUrl = 'https:' + sourceUrl;
          } else {
            const url = new URL(sourceUrl, window.location.href);
            sourceUrl = url.href;
          }
        }
        
        return {
          sourceUrl,
          alt_text: img.getAttribute('alt') || ''
        };
      })
      .filter(img => img.sourceUrl && !img.sourceUrl.includes('_60_80')) // Filter out thumbnails
    ).catch(() => []);

    // Extract sizes
    const sizes = await page.$$eval('.goods-case__sizes-item, .product__sizes-item', sizeEls =>
      sizeEls.map(el => {
        const sizeText = el.textContent?.trim() || '';
        const isAvailable = el.classList.contains('available') || 
                           !el.classList.contains('unavailable');
        return {
          size: sizeText,
          is_available: isAvailable
        };
      }).filter(s => s.size)
    ).catch(() => []);

    // Handle images with S3 upload
    let imagesWithMushUrl: Image[];
    
    if (options?.existingImages && !options?.scrapeImages) {
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
        imagesWithMushUrl = imagesData;
      }
    }

    // Construct final Item
    const finalItem: Item = {
      sourceUrl,
      product_id,
      title,
      images: imagesWithMushUrl,
      price,
      currency,
      description,
      sizes: sizes.length > 0 ? sizes : undefined,
      vendor: 'Etnodim',
      status: 'ACTIVE'
    };

    return [Utils.formatItem(finalItem)];

  } catch (error) {
    log.error(`Error scraping item at ${sourceUrl}: ${error}`);
    return [Utils.formatItem({
      sourceUrl,
      product_id: 'unknown',
      title: `Error scraping item`,
      description: error instanceof Error ? error.message : String(error),
      status: undefined,
      vendor: 'Etnodim',
      price: 0,
      currency: 'USD',
      images: [],
      sizes: [],
      tags: [],
    })];
  }
}

// Define the default export for the scraper
const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper;