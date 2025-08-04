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
    title: '.product-about__title, h1',
    price: '.product-price .num, .product-about__price .num',
    images: '.product__slider-case img.product_image, img.product_image',
    description: '.product-tabs__content[data-tab-content="description"]',
    productId: '[data-content-id], [data-product-id]',
    sizeWrapper: '.product-size__options',
    colorWrapper: '.product-variant__selected'
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
    // Wait for content to load
    await page.waitForLoadState('domcontentloaded');
    
    // Check if we're on a 404 page
    const pageTitle = await page.title();
    if (pageTitle.includes('404') || pageTitle.includes('not found')) {
      throw new Error(`Page not found (404): ${sourceUrl}`);
    }
    
    // Wait a bit for any dynamic content
    await page.waitForTimeout(2000);
    
    // Extract title - try multiple selectors
    let title = '';
    const titleSelectors = [
      '.product-about__title',
      'h1.product-about__title', 
      '.product__title',
      'h1'
    ];
    
    for (const selector of titleSelectors) {
      try {
        const titleEl = await page.$(selector);
        if (titleEl) {
          const text = await titleEl.textContent();
          if (text && text.trim()) {
            title = text.trim();
            break;
          }
        }
      } catch (e) {
        // Continue to next selector
      }
    }
    
    if (!title) {
      log.debug('Could not extract title from any selector');
    }

    // Extract product ID
    let product_id = 'unknown';
    try {
      // Try data-content-id first (seen in the HTML)
      const contentIdEl = await page.$('[data-content-id]');
      if (contentIdEl) {
        product_id = await contentIdEl.getAttribute('data-content-id') || 'unknown';
      }
      
      if (product_id === 'unknown') {
        // Try data-product-id
        const productIdEl = await page.$('[data-product-id]');
        if (productIdEl) {
          product_id = await productIdEl.getAttribute('data-product-id') || 'unknown';
        }
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

    // Extract price and sale_price
    let price = 0;
    let sale_price: number | undefined;
    let currency = 'USD'; // Default currency
    try {
      // Check for both old and new prices (sale scenario)
      const oldPriceEl = await page.$('.product-price .num.old');
      const newPriceEl = await page.$('.product-price .num.new');
      
      if (oldPriceEl && newPriceEl) {
        // Check if old price actually has content (not empty)
        const oldPriceText = await oldPriceEl.textContent();
        const newPriceText = await newPriceEl.textContent();
        
        if (oldPriceText && oldPriceText.trim()) {
          // Sale scenario: old price is the regular price, new price is the sale price
          price = parseFloat((oldPriceText || '0').replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
          sale_price = parseFloat((newPriceText || '0').replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
        } else {
          // New price only - it's the regular price
          price = parseFloat((newPriceText || '0').replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
        }
      } else {
        // No sale - try data attributes first
        const productAbout = await page.$('.product-about[data-value]');
        if (productAbout) {
          const dataValue = await productAbout.getAttribute('data-value');
          const dataCurrency = await productAbout.getAttribute('data-currency');
          if (dataValue) {
            price = parseFloat(dataValue) || 0;
          }
          if (dataCurrency) {
            currency = dataCurrency;
          }
        }
        
        // Fallback to any price element
        if (price === 0) {
          const priceEl = await page.$('.product-price .num');
          if (priceEl) {
            const priceText = await priceEl.textContent();
            price = parseFloat((priceText || '0').replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
          }
        }
      }
      
      // Detect currency from symbol
      const currencyEl = await page.$('.product-price .currency');
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
    let description = '';
    try {
      const descEl = await page.$('.product-tabs__content[data-tab-content="description"], .product-about__description');
      if (descEl) {
        description = await descEl.textContent() || '';
        description = description.trim();
      }
    } catch (e) {
      log.debug(`Could not extract description: ${e}`);
    }

    // Extract images - look for product images in the slider
    const imagesData = await page.$$eval('.product__slider-case img.product_image, img.product_image', imgs =>
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
      .filter(img => img.sourceUrl && !img.sourceUrl.includes('_60_80') && !img.sourceUrl.includes('_65_87')) // Filter out thumbnails
    ).catch(() => []);

    // Extract sizes - look for the product size buttons (only from static container to avoid duplicates)
    const sizes = await page.$$eval('.product-about-static .product-size__button', sizeEls =>
      sizeEls.map(el => {
        const sizeText = el.textContent?.trim() || '';
        // Check if button has __unavailable class
        const isAvailable = !el.classList.contains('__unavailable');
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
      sale_price,
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