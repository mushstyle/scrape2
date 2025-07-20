import { type Page } from 'playwright';
import type { Item, Image, Size } from '../types/item.js';
import * as Utils from '../db/db-utils.js';
import { uploadImageUrlToS3 } from '../providers/s3.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('serenity-wear.com');

export const SELECTORS = {
  productGrid: '.products', // The grid containing the products
  productLinks: '.product .product-link', // Links to individual product pages
  pagination: {
    type: 'scroll' as const,
    loadMoreIndicator: '.et-infload-btn.et-shop-infload-btn' // "Load More" button selector
  },
  product: {
    title: '.product_title.entry-title', // Product title selector
    price: '.woocommerce-Price-amount bdi', // Price selector
    images: '.woocommerce-product-gallery__image img', // Product gallery images
    sku: '.sku', // SKU selector
    description: '#tab-description p', // Product description
    categories: '.posted_in a', // Product categories
    sizeSelector: 'select[name="attribute_pa_size"]', // Size dropdown
    colorClass: 'product_cat-', // Color is in the product category
    variationsData: '.variations_form.cart', // Contains JSON with all variations
    currency: '.woocommerce-Price-currencySymbol', // Currency symbol
  }
};

/**
 * Gathers item URLs from the current page
 * @param page Playwright page object
 * @returns Set of product URLs
 */
export async function getItemUrls(page: Page): Promise<Set<string>> {
  const links = await page.$$eval(SELECTORS.productLinks, (els) => els.map((el) => (el as HTMLAnchorElement).href));
  return new Set(links);
}

/**
 * Scrolls to load more products and returns status
 * @param page Playwright page object
 * @returns boolean indicating if more content could be loaded
 */
export async function paginate(page: Page): Promise<boolean> {
  const loadMoreButtonSelector = SELECTORS.pagination.loadMoreIndicator;
  const allLoadedSelector = '.et-infload-to-top'; // Selector for the "All products loaded" indicator
  const productSelector = SELECTORS.productLinks;

  try {
    // 1. Check if the "All products loaded" indicator is visible
    const allLoadedIndicator = page.locator(allLoadedSelector);
    if (await allLoadedIndicator.isVisible({ timeout: 1000 })) {
      log.debug(`   Pagination ended: "${await allLoadedIndicator.textContent()}" indicator is visible.`);
      return false; // Explicit end indicator found
    }

    // 2. Check if the "Load More" button exists and is visible/clickable
    const loadMoreButton = page.locator(loadMoreButtonSelector);
    try {
      await loadMoreButton.waitFor({ state: 'visible', timeout: 7000 });
    } catch (error) {
      log.debug(`   Pagination likely ended: Load more button (${loadMoreButtonSelector}) did not become visible.`);
      return false;
    }

    // Check for explicit hidden state (e.g., parent with 'hide-btn' class)
    const isHiddenExplicitly = await loadMoreButton.evaluate(el => el.closest('.hide-btn') !== null).catch(() => false);
    if (isHiddenExplicitly) {
      log.debug(`   Pagination ended: Load more button (${loadMoreButtonSelector}) found but explicitly hidden.`);
      return false;
    }

    // 3. Click the button
    await loadMoreButton.scrollIntoViewIfNeeded();
    await loadMoreButton.click({ timeout: 5000 });

    // 4. Wait for network activity to potentially settle
    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch (e) {
      log.debug("   Network did not become idle after click (timeout or error), proceeding anyway.");
    }

    // 5. Indicate pagination attempt was made
    return true;

  } catch (error) {
    // Handle unexpected errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('Execution context was destroyed')) {
      log.debug(`   Pagination click likely caused navigation/context destruction for ${loadMoreButtonSelector}. Attempting to continue.`);
      return true; // Let the main loop handle potential navigation
    } else if (error instanceof Error && (errorMessage.includes('timeout') || errorMessage.includes('waitFor failed'))) {
      // Log specific timeout/wait errors related to the button
      log.debug(`   Pagination ended: Load more button check timed out or failed.`);
    } else {
      // Log other generic errors
      log.error(`   Unexpected error during pagination: ${errorMessage}`);
    }
    return false; // Error occurred
  }
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
    await page.waitForSelector(SELECTORS.product.title, { timeout: 10000 });

    // --- Data Extraction (mostly outside evaluate) ---
    const title = await page.$eval(SELECTORS.product.title, (el) => el.textContent?.trim() || '').catch(() => '');

    // --- Price Extraction ---
    // Find original price (<del>) and sale price (<ins>)
    const originalPriceText = await page.$eval('p.price del .woocommerce-Price-amount bdi', el => el.textContent?.trim()).catch(() => null);
    const salePriceText = await page.$eval('p.price ins .woocommerce-Price-amount bdi', el => el.textContent?.trim()).catch(() => null);
    const mainPriceText = await page.$eval('p.price > .woocommerce-Price-amount bdi', el => el.textContent?.trim()).catch(() => null); // Price when not on sale

    let price: number;
    let sale_price: number | undefined = undefined;
    let priceTextForCurrency: string;

    if (salePriceText && originalPriceText) {
      // Sale case: <del>original</del> <ins>sale</ins>
      price = parseFloat(originalPriceText.replace(/[^\d.]/g, '')) || 0;
      sale_price = parseFloat(salePriceText.replace(/[^\d.]/g, '')) || 0;
      priceTextForCurrency = salePriceText; // Use sale price text to extract currency
    } else {
      // Not on sale (or only one price found)
      const currentPriceText = originalPriceText || salePriceText || mainPriceText || '0';
      price = parseFloat(currentPriceText.replace(/[^\d.]/g, '')) || 0;
      sale_price = undefined;
      priceTextForCurrency = currentPriceText;
    }

    const currencyMatch = priceTextForCurrency.match(/[^\d\s.,]+/);
    const currency = currencyMatch ? currencyMatch[0] : 'USD'; // Default to USD if not found

    const description = await page.$eval(SELECTORS.product.description, (el) => el.innerHTML.trim()).catch(() => '');
    let sku: string;
    try {
      sku = await page.$eval(SELECTORS.product.sku, el => el.textContent?.trim() || '');
      if (!sku) throw new Error("SKU element found but empty.");
    } catch (e) {
      const fallbackSku = sourceUrl.split('/').filter(Boolean).pop() || ''; // Extract last path segment
      log.debug(`   Could not extract SKU using selector "${SELECTORS.product.sku}" for ${sourceUrl}. Falling back to SKU derived from URL: "${fallbackSku}". Error: ${e instanceof Error ? e.message : String(e)}`);
      sku = fallbackSku;
      if (!sku) {
        log.error(`   Failed to extract primary or fallback SKU for ${sourceUrl}. Using empty string.`);
        sku = ''; // Ensure sku is always a string
      }
    }

    // --- Image Extraction ---
    const imagesWithoutMushUrl: Image[] = await page.$$eval(SELECTORS.product.images, (imgs, title) =>
      imgs.map(img => {
        const imgEl = img as HTMLImageElement;
        let url = imgEl.getAttribute('href') || imgEl.src; // Prioritize href for zoom
        if (url && url.startsWith('//')) url = 'https:' + url;
        return {
          sourceUrl: url || '',
          alt_text: imgEl.alt || title
        };
      }).filter(img => img.sourceUrl)
      , title).catch(() => []); // Pass title for alt text
    const validImages = imagesWithoutMushUrl.filter(img => img.sourceUrl && !img.sourceUrl.startsWith('data:') && !img.sourceUrl.includes('placeholder'));

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
      // --- Use the helper function for S3 Upload Logic ---
      if (options?.uploadToS3 !== false) {

        imagesWithMushUrl = await uploadImagesToS3AndAddUrls(validImages, sourceUrl);

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        imagesWithMushUrl = validImages;

      }
      // --- End S3 Upload Logic ---
    }

    // --- Sizes (JSON Approach) ---
    let sizes: Size[] = [];
    try {
      // First wait for the variations form to be present
      await page.waitForSelector('form.variations_form.cart', { timeout: 5000 }).catch(() => null);
      
      // Extract variations data and size options in a single evaluate call to avoid context destruction
      const sizeData = await page.evaluate(() => {
        const form = document.querySelector('form.variations_form.cart') as HTMLFormElement;
        if (!form) return null;
        
        const variationsJson = form.dataset.product_variations;
        const variationsData = variationsJson ? JSON.parse(variationsJson) : [];
        
        // Try both attribute selectors
        let sizeElements = Array.from(document.querySelectorAll('ul.variable-items-wrapper[data-attribute_name="attribute_pa_size"] li.variable-item'));
        if (sizeElements.length === 0) {
          sizeElements = Array.from(document.querySelectorAll('ul.variable-items-wrapper[data-attribute_name="attribute_size"] li.variable-item'));
        }
        
        const possibleSizes = sizeElements.map(el => (el as HTMLElement).dataset.value?.trim().toUpperCase()).filter(Boolean) as string[];
        
        return {
          variationsData,
          possibleSizes
        };
      }).catch(() => null);

      if (sizeData && sizeData.possibleSizes.length > 0) {
        if (sizeData.variationsData.length > 0) {
          const variationStockMap = new Map<string, boolean>();
          for (const variation of sizeData.variationsData) {
            // Check both attribute_pa_size and attribute_size in the JSON
            const sizeKey = variation.attributes?.attribute_pa_size?.toUpperCase() || 
                           variation.attributes?.attribute_size?.toUpperCase();
            if (sizeKey) {
              variationStockMap.set(sizeKey, variation.is_in_stock === true);
            }
          }

          sizes = sizeData.possibleSizes.map(size => ({
            size: size,
            // Available if it exists in the stock map and is marked as true, otherwise false
            is_available: variationStockMap.get(size) ?? false
          }));
        } else {
          // Fallback if JSON is missing/empty but UI elements exist: mark all as available (optimistic default)
          log.debug(`Variations JSON missing or empty for ${sourceUrl}, but size UI elements found. Marking all as available.`);
          sizes = sizeData.possibleSizes.map(size => ({ size: size, is_available: true }));
        }
      } else {
        log.debug(`No size options found (UI or JSON) for ${sourceUrl}.`);
      }

    } catch (error) {
      log.error(`Error processing size variations for ${sourceUrl}:`, error);
      sizes = []; // Ensure sizes is an empty array on error
    }

    // --- Color ---
    // Attempt to extract color from variations JSON data if available
    const color = await page.$eval(SELECTORS.product.colorClass, (el) => el.textContent?.trim() || '').catch(() => '');

    // --- Tags/Categories ---
    const categories: string[] = await page.$$eval(SELECTORS.product.categories, (els) =>
      els.map(el => el.textContent?.trim()).filter(Boolean) as string[]
    ).catch(() => []);
    const tags = categories.filter((category): category is string => category !== undefined);

    // --- Construct Final Item ---
    const item: Item = {
      sourceUrl: sourceUrl,
      product_id: sku,
      title,
      images: imagesWithMushUrl,
      price, // Original price
      sale_price, // Sale price (optional)
      description,
      color,
      sizes: sizes.length > 0 ? sizes : undefined,
      type: tags[0], // First category as type
      tags: tags.length > 1 ? tags.slice(1) : undefined, // Remaining as tags
      currency,
    };

    return Utils.formatItem(item);

  } finally {
    // await browser.close(); // Browser lifecycle managed by the caller
  }
}

// Define the scraper object
const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper;