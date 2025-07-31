import type { Page } from 'playwright';
import type { Item, Image, Size } from '../types/item.js';
import * as Utils from "../db/db-utils.js";
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('amgbrand.com');

/**
 * Adapted from iam-store.com scraper
 */

export const SELECTORS = {
  productGrid: '#gf-products', // Grid container
  productLinks: '#gf-products .spf-product-card__image-wrapper', // Product links within the grid
  pagination: {
    type: 'scroll' as const, // Pagination type is infinite scroll
    pattern: 'page={n}',      // Still supports numbered pagination for other collection pages
  },
  product: {
    title: '.product__title',
    price: '[data-price-wrapper] [data-product-price] .money', // Price element selector
    comparePrice: '[data-price-wrapper] s[data-compare-price] .money', // Selector for compare at price (original price)
    productId: 'input[name="product-id"]', // Standard Shopify product ID input (might need fallback)
    images: '.product__gallery-item-img img', // Get the img elements directly in the gallery
    sizes: 'div[data-option-index="0"] .swatch__list-item label', // Size labels (assuming first option is size)
    colors: 'div[data-option-index="1"] .swatch__list-item-color label', // Color labels (assuming second option is color)
    description: '.product__details-body' // Description block
  }
};

export async function getItemUrls(page: Page): Promise<Set<string>> {
  await page.waitForSelector(SELECTORS.productLinks, { timeout: 10000 });
  const links = await page.$$eval(SELECTORS.productLinks, els => els.map(e => (e as HTMLAnchorElement).href));
  return new Set(links.map(link => new URL(link, page.url()).href)); // Ensure absolute URLs
}

/**
 * Attempts to load more products by appending page numbers to URL.
 * @param page Playwright page object
 * @returns `true` if more products were loaded, `false` if no more products to load.
 */
export async function paginate(page: Page): Promise<boolean> {
  try {
    // Check if "no products" message is present
    const noProductsMessage = await page.evaluate(() => {
      const element = document.querySelector('.spf-col-xl-12.spf-col-lg-12.spf-col-md-12.spf-col-sm-12');
      return element?.textContent?.includes('Sorry, there are no products in this collection');
    });

    if (noProductsMessage) {
      log.debug('No products in collection message found');
      return false;
    }

    // Get current URL and page number
    const currentUrl = new URL(page.url());
    const currentPage = parseInt(currentUrl.searchParams.get('page') || '1');
    const nextPage = currentPage + 1;

    // Update URL with next page number
    currentUrl.searchParams.set('page', nextPage.toString());
    
    log.debug(`Navigating to page ${nextPage}: ${currentUrl.toString()}`);
    
    // Navigate to next page
    await page.goto(currentUrl.toString(), { waitUntil: 'networkidle' });

    // Check if we have products on this page
    const hasProducts = await page.evaluate((selector) => {
      return document.querySelectorAll(selector).length > 0;
    }, SELECTORS.productLinks);

    // Also check for "no products" message after navigation
    const noProductsAfterNav = await page.evaluate(() => {
      const element = document.querySelector('.spf-col-xl-12.spf-col-lg-12.spf-col-md-12.spf-col-sm-12');
      return element?.textContent?.includes('Sorry, there are no products in this collection');
    });

    if (hasProducts && !noProductsAfterNav) {
      log.debug(`Successfully loaded page ${nextPage}`);
      return true;
    } else {
      log.debug(`No more products found on page ${nextPage}`);
      return false;
    }
  } catch (error) {
    log.debug(`Pagination failed:`, error);
    return false;
  }
}

// -----------------------
// Default export (Scraper)
// -----------------------

export const scrapeItem = async (page: Page, options?: {
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> => {
  const sourceUrl = page.url();
  try {
    // Page is already at sourceUrl, ensure content is loaded.
    await page.waitForSelector(SELECTORS.product.title, { timeout: 10000 });

    // --- Data Extraction in Node.js ---
    const title = await page.$eval(SELECTORS.product.title, el => el.textContent?.trim() || 'Unknown Product').catch(() => 'Unknown Product');

    // --- Product ID ---
    let productId = await page.$eval(SELECTORS.product.productId, el => (el as HTMLInputElement).value).catch(() => '');
    if (!productId) { // Fallback using URL parsing
      const match = sourceUrl.match(/\/products\/([a-zA-Z0-9-]+)/);
      productId = match && match[1] ? match[1] : sourceUrl;
    }

    // --- Price ---
    const priceText = await page.$eval(SELECTORS.product.price, el => el.textContent?.trim() || '0').catch(() => '0');
    const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
    const comparePriceText = await page.$eval(SELECTORS.product.comparePrice, el => el.textContent?.trim() || '0').catch(() => '0');
    const comparePrice = parseFloat(comparePriceText.replace(/[^0-9.]/g, '')) || 0;
    const finalPrice = comparePrice > 0 ? comparePrice : price;
    const salePrice = comparePrice > 0 && comparePrice !== price ? price : undefined;
    const currencyMatch = priceText.match(/[^\d\s.,]/);
    const currency = currencyMatch ? currencyMatch[0] : 'USD'; // Default currency

    // --- Images ---
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
      // Normal image scraping flow
      const imagesWithoutMushUrl: Image[] = await page.$$eval(SELECTORS.product.images, (imgs) => {
        return imgs.map((img) => {
          const imgEl = img as HTMLImageElement;
          let src = imgEl.dataset.src || imgEl.currentSrc || imgEl.src;
          if (src && src.startsWith('//')) {
            src = 'https:' + src;
          }
          if (src && src.includes('{width}')) {
            src = src.replace('{width}', '1000');
          }
          return {
            sourceUrl: src,
            alt_text: imgEl.alt || ''
          };
        });
      }).catch(() => []);
      const validImages = imagesWithoutMushUrl.filter(img => img.sourceUrl && !img.sourceUrl.startsWith('data:'));

      // --- Use the helper function for S3 Upload Logic --- 
      if (options?.uploadToS3 !== false) {
        imagesWithMushUrl = await uploadImagesToS3AndAddUrls(validImages, sourceUrl);
      } else {
        // Skip S3 upload, just use scraped images with sourceUrl only
        imagesWithMushUrl = validImages;
      }
      // --- End S3 Upload Logic ---
    }

    // --- Sizes & Colors ---
    const sizes: Size[] = await page.$$eval(SELECTORS.product.sizes, labels =>
      labels.map(label => ({
        size: label.textContent?.trim() || '',
        is_available: !label.parentElement?.classList.contains('disabled')
      })).filter(s => s.size)
    ).catch(() => []);

    const colors: string[] = await page.$$eval(SELECTORS.product.colors, labels =>
      labels.map(label => label.textContent?.trim() || '').filter(Boolean)
    ).catch(() => []);
    const primaryColor = colors[0];

    // --- Description ---
    const description = await page.$eval(SELECTORS.product.description, el => el.innerHTML.trim()).catch(() => '');

    // --- Construct Final Item ---
    const item: Item = {
      sourceUrl,
      product_id: productId,
      title,
      description,
      images: imagesWithMushUrl,
      price: finalPrice,
      sale_price: salePrice,
      currency,
      sizes: sizes.length > 0 ? sizes : undefined,
      color: primaryColor || undefined,
      vendor: 'amgbrand'
    };

    return [Utils.formatItem(item)];

  } catch (e) {
    log.error(`Error scraping ${sourceUrl}:`, e);
    const fallbackItem: Item = { sourceUrl, product_id: sourceUrl, title: 'Scraping Failed', images: [], price: 0 };
    return [Utils.formatItem(fallbackItem)];
  }
};

// Define the scraper object
const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper; 