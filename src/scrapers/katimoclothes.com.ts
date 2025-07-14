import type { Page } from 'playwright';
import { Item, Image, Size } from '../types/item.js';
import * as Utils from "../db/db-utils.js";
import { uploadImageUrlToS3 } from '../providers/s3.js';
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../lib/logger.js';

/**
 * Scraper for katimoclothes.com that uses "Load More" button pagination
 */

export const SELECTORS = {
  productGrid: '.product_list_km',
  productLinks: '.km-prod a',
  pagination: {
    loadMoreIndicator: '#load_more_km',
    countIndicator: '#load_more_km .term-count',
    loadMoreButton: '#load_more_km .n-btn'
  },
  product: {
    title: 'h1.fs_me',
    price: '.prod-price .woocommerce-Price-amount',
    images: '#gall-items > div[data-p-i]',
    description: '.km-prod-des .hg-t.hg-fw',
    productType: '.tag-i.n-btn span',
    sizes: 'fieldset.variation_size label',
    sku: 'p.sku',
    formData: 'form.variations_form.cart'
  }
};

/**
 * Gathers item URLs from the current page
 * @param page Playwright page object
 * @returns Set of product URLs
 */
export async function getItemUrls(page: Page): Promise<Set<string>> {
  await page.waitForSelector(SELECTORS.productLinks, { timeout: 10000 });
  const links = await page.$$eval(SELECTORS.productLinks, els => els.map(e => (e as HTMLAnchorElement).href));
  return new Set(links);
}

/**
 * Handles pagination by clicking the "More products" button until all items are loaded.
 * Stops when the count indicator shows "N of N".
 * @param page Playwright page object
 * @returns `true` if pagination occurred, `false` if all items are loaded or the button is gone.
 * @throws If selectors are not found or parsing fails unexpectedly.
 */
export async function paginate(page: Page): Promise<boolean> {
  const log = logger.createContext('katimoclothes.com');
  const loadMoreIndicator = await page.$(SELECTORS.pagination.loadMoreIndicator);
  if (!loadMoreIndicator) {
    log.debug('Load more indicator not found. Assuming end of pagination.');
    return false;
  }

  try {
    await page.waitForSelector(SELECTORS.pagination.countIndicator, { timeout: 5000 });
    const countText = await page.$eval(SELECTORS.pagination.countIndicator, el => el.textContent?.trim() || '');
    const match = countText.match(/(\d+)\s+of\s+(\d+)/);

    if (match) {
      const currentCount = parseInt(match[1], 10);
      const totalCount = parseInt(match[2], 10);

      log.debug(`Pagination status: ${currentCount} of ${totalCount}`);

      if (currentCount >= totalCount) {
        log.debug('All items loaded.');
        return false;
      }
    } else {
      log.normal(`Could not parse count text: "${countText}". Proceeding with click.`);
    }
  } catch (err) {
    log.normal(`Could not find or evaluate count indicator (${SELECTORS.pagination.countIndicator}). Proceeding with click attempt: ${err instanceof Error ? err.message : String(err)}`);
  }

  const loadMoreButton = await page.$(SELECTORS.pagination.loadMoreButton);
  if (!loadMoreButton) {
    log.debug('Load more button not found inside the indicator. Assuming end of pagination.');
    return false;
  }

  try {
    await loadMoreButton.click({ timeout: 5000 });
    await page.waitForTimeout(3000);
    return true;
  } catch (err) {
    log.error(`Error clicking load more button: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// -----------------------
// Default export (Scraper)
// -----------------------

const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper;

/**
 * Helper function to log element details for debugging
 */
export async function logElementDetails(page: Page, selector: string, name: string): Promise<void> {
  const log = logger.createContext('katimoclothes.com');
  try {
    const exists = await page.$(selector) !== null;
    log.debug(`${name} element ${exists ? 'exists' : 'does not exist'}: ${selector}`);

    if (exists) {
      const text = await page.$eval(selector, el => el.textContent?.trim() || 'empty');
      log.debug(`${name} text: "${text}"`);
    }
  } catch (err) {
    log.error(`Error checking ${name} element: ${err instanceof Error ? err.message : String(err)}`);
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
    // Page is already at sourceUrl. Caller should ensure DOM is loaded.
    await page.waitForSelector(SELECTORS.product.title, { timeout: 10000 });

    // Define intermediate type for data extracted in evaluate
    type ScrapedData = Omit<Item, 'mushUrl' | 'status' | 'images'> & { // Exclude images initially
      images: Omit<Image, 'mushUrl'>[]; // Images without mushUrl
      sizes: Size[];
    };

    const itemData = await page.evaluate((): ScrapedData => {
      // --- Original evaluate logic to extract title, price, description, sku, images (without mushUrl), sizes --- 
      const title = document.querySelector('h1.fs_me')?.textContent?.trim() || '';

      // Price parsing (Keep this original logic)
      let price = 0;
      let salePrice: number | undefined;
      let currency = 'UAH';
      const priceContainer = document.querySelector('.prod-price');
      if (priceContainer) {
        const salePriceEl = priceContainer.querySelector('ins .woocommerce-Price-amount bdi');
        const originalPriceEl = priceContainer.querySelector('del .woocommerce-Price-amount bdi');
        if (salePriceEl && originalPriceEl) {
          const originalPriceText = (originalPriceEl.textContent ?? '').replace(/[^\d.,]/g, '');
          const parsedOriginal = parseFloat(originalPriceText.replace(',', '.'));
          price = isNaN(parsedOriginal) ? 0 : parsedOriginal;
          const salePriceText = (salePriceEl.textContent ?? '').replace(/[^\d.,]/g, '');
          const parsedSale = parseFloat(salePriceText.replace(',', '.'));
          salePrice = isNaN(parsedSale) ? undefined : parsedSale;
        } else {
          const regularPriceEl = priceContainer.querySelector('.woocommerce-Price-amount bdi');
          if (regularPriceEl) {
            const priceText = (regularPriceEl.textContent ?? '').replace(/[^\d.,]/g, '');
            const parsedPrice = parseFloat(priceText.replace(',', '.'));
            price = isNaN(parsedPrice) ? 0 : parsedPrice;
          }
          salePrice = undefined;
        }
      } else {
        const fallbackPriceEl = document.querySelector('.woocommerce-Price-amount bdi');
        if (fallbackPriceEl) {
          const priceText = (fallbackPriceEl.textContent ?? '').replace(/[^\d.,]/g, '');
          const parsedPrice = parseFloat(priceText.replace(',', '.'));
          price = isNaN(parsedPrice) ? 0 : parsedPrice;
        }
        salePrice = undefined;
      }
      const currencySymbol = document.querySelector('.woocommerce-Price-currencySymbol')?.textContent || '';
      if (currencySymbol === '€') {
        currency = 'EUR';
      }
      // Keep UAH as default if no symbol or ₴

      const description = document.querySelector('.km-prod-des .hg-t.hg-fw')?.textContent?.trim() || '';
      const productType = document.querySelector('.tag-i.n-btn span')?.textContent?.trim() || '';
      const vendor = 'Katimo';
      const sku = document.querySelector('p.sku')?.textContent?.replace('Style:', '')?.trim() || '';

      // Image extraction (Keep original logic)
      const images: Omit<Image, 'mushUrl'>[] = [];
      const galleryItems = document.querySelectorAll('#gall-items > div[data-p-i]');
      galleryItems.forEach(img => {
        const imgUrl = img.getAttribute('data-p-i');
        if (imgUrl && !images.some(i => i.sourceUrl === imgUrl)) {
          images.push({ sourceUrl: imgUrl, alt_text: title || 'Katimo product image' });
        }
      });
      if (images.length === 0) {
        const flickityItems = document.querySelectorAll('#gall-full .flickity-slider > div.bgcov');
        flickityItems.forEach(img => {
          let imgUrl = img.getAttribute('data-p-i');
          if (!imgUrl) {
            const style = img.getAttribute('style') || '';
            const match = style.match(/background-image:\s*url\(['"]?(.*?)['"]?\)/);
            if (match && match[1]) imgUrl = match[1].replace(/&quot;/g, '');
          }
          if (imgUrl && !images.some(i => i.sourceUrl === imgUrl)) {
            images.push({ sourceUrl: imgUrl, alt_text: title || 'Katimo product image' });
          }
        });
      }

      // Sizes extraction
      const sizes: Size[] = [];
      const sizeLabels = document.querySelectorAll('fieldset.variation_size label');
      sizeLabels.forEach(label => {
        const sizeEl = label.querySelector('p'); // Get the <p> tag containing the size text
        if (sizeEl) {
          const sizeText = sizeEl.textContent?.trim() ?? '';
          const sizeValue = sizeEl.getAttribute('s-val') || sizeText; // Use s-val if present

          // CORRECT AVAILABILITY CHECK: Check if the label element itself has the 'out_of_var' class
          const isAvailable = !label.classList.contains('out_of_var');

          if (sizeValue) {
            // Use the sizeValue which might come from s-val or text content
            sizes.push({ size: sizeValue.toUpperCase(), is_available: isAvailable });
          }
        }
      });

      let finalProductId = sku || 'unknown'; // Use SKU as primary ID
      if (finalProductId === 'unknown') {
        const urlParts = window.location.pathname.split('/');
        const slug = urlParts[urlParts.length - 2] || '';
        if (slug) finalProductId = `katimo-${slug}`; // Fallback to slug
      }

      return {
        sourceUrl: window.location.href,
        product_id: finalProductId,
        title,
        description,
        vendor,
        type: productType || undefined,
        images, // Return images without mushUrl initially
        price, // Use the extracted price
        sale_price: salePrice, // Use the extracted sale_price
        currency, // Use the extracted currency
        sizes,
        tags: [],
      };
    });

    // --- Use the helper function for S3 Upload Logic --- 
    // Image handling with existing images support
    let imagesWithMushUrl: Image[];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
      const log = logger.createContext('katimoclothes.com');
      log.debug(`Using ${options.existingImages.length} existing images from database`);
      imagesWithMushUrl = options.existingImages.map(img => ({
        sourceUrl: img.sourceUrl,
        mushUrl: img.mushUrl,
        alt_text: undefined
      }));
    } else {
      if (options?.uploadToS3 !== false) {

        imagesWithMushUrl = await uploadImagesToS3AndAddUrls(itemData.images, itemData.sourceUrl);

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        imagesWithMushUrl = itemData.images;

      }
    }
    // --- End S3 Upload Logic ---

    // Construct the final Item object using the updated images array
    const finalItem: Item = {
      ...itemData,
      images: imagesWithMushUrl, // Use images processed by the helper
      status: 'ACTIVE' // Set status
    };

    return Utils.formatItem(finalItem);

  } catch (error) {
    const log = logger.createContext('katimoclothes.com');
    log.error(`Error scraping item ${sourceUrl}: ${error instanceof Error ? error.message : String(error)}`);
    throw error; // Rethrow
  }
}