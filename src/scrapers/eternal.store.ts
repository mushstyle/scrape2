import type { Page } from 'playwright';
import { Item, Image, Size } from '../types/item.js';
import * as Utils from "../db/db-utils.js";
import { uploadImageUrlToS3 } from '../providers/s3.js';
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../lib/logger.js';

/**
 * Scraper for eternal.store – updated to Phase 3 interface.
 * This store paginates via `?page=N` query parameter.
 */

export const SELECTORS = {
  productGrid: '#product-grid',
  productLinks: '.card-product',
  product: {
    title: '.info-block__head--title',
    price: '.price-block__price',
    images: '.image-block__image img',
    sizes: 'input[name="Size"]',
    description: '.body-block__description',
    productId: 'input[name="product-id"]',
    material: '.details-block__span',
    color: '.swatch__link'
  }
};

/**
 * Gather product URLs from the current DOM state.
 */
export async function getItemUrls(page: Page): Promise<Set<string>> {
  try {
    await page.waitForSelector(SELECTORS.productLinks, { timeout: 10000 });
  } catch (_) {
    return new Set(); // Empty set if no products found.
  }

  const urls = await page.evaluate((selector) => {
    return Array.from(document.querySelectorAll(selector))
      .map(el => (el as HTMLAnchorElement).href);
  }, SELECTORS.productLinks);

  return new Set(urls);
}

/**
 * Navigate to the next `?page=N` and return `true` if that page appears
 * to contain at least one product, else `false`.
 */
export async function paginate(page: Page): Promise<boolean> {
  const urlObj = new URL(page.url());
  const currentPage = parseInt(urlObj.searchParams.get('page') || '1', 10);
  urlObj.searchParams.set('page', String(currentPage + 1));

  try {
    const response = await page.goto(urlObj.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 10000
    });

    if (!response || !response.ok()) return false;

    const urls = await getItemUrls(page);
    return urls.size > 0;
  } catch (_) {
    return false;
  }
}

export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  const sourceUrl = page.url();
  try {
    // Page is already at sourceUrl, ensure content is loaded.
    await page.waitForSelector(SELECTORS.product.title, { timeout: 10000 });

    // Define intermediate type
    type ScrapedData = Omit<Item, 'mushUrl' | 'status'> & {
      images: Image[];
      sizes: Size[];
    };

    const itemData = await page.evaluate((SEL): ScrapedData => {
      const title = document.querySelector(SEL.title)?.textContent?.trim() || '';
      const productId = document.querySelector(SEL.productId)?.getAttribute('value') || '';

      // --- Price & Currency ---
      let price = 0;
      let currency = 'USD';
      const priceEl = document.querySelector(SEL.price);
      if (priceEl) {
        price = parseFloat(priceEl.textContent?.replace(/[^\d.]/g, '') || '0');
        const currencyMatch = priceEl.textContent?.match(/[^\d\s.,]+/);
        currency = currencyMatch ? currencyMatch[0] : 'USD';
      }

      // --- Images ---
      const images: Image[] = Array.from(document.querySelectorAll(SEL.images))
        .map(el => {
          const img = el as HTMLImageElement;
          return {
            sourceUrl: img.src,
            alt_text: img.alt || title,
          };
        })
        .filter(img => img.sourceUrl && !img.sourceUrl.startsWith('data:'));

      // --- Description & Material ---
      const description = document.querySelector(SEL.description)?.textContent?.trim() || '';
      const material = document.querySelector(SEL.material)?.textContent?.trim() || undefined;

      // --- Sizes ---
      const sizeElements = Array.from(document.querySelectorAll(SEL.sizes));
      const sizes: Size[] = sizeElements.map(el => {
        const size = el.textContent?.trim() || '';
        return {
          size,
          is_available: !el.classList.contains('sold-out') // Example availability
        };
      }).filter(s => s.size);

      // --- Color ---
      const color = document.querySelector(SEL.color)?.textContent?.trim() || undefined;

      return {
        sourceUrl: window.location.href,
        product_id: productId,
        title,
        description,
        vendor: 'eternal-store',
        images,
        price,
        currency,
        sizes,
        color,
        tags: [], // Initialize tags
        // No sale price field found in selectors
      };
    }, SELECTORS.product);

    // Image handling with existing images support
    let imagesWithMushUrl: Image[];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
      logger.normal(`[eternal.store] Using ${options.existingImages.length} existing images from database`);
      imagesWithMushUrl = options.existingImages.map(img => ({
        sourceUrl: img.sourceUrl,
        mushUrl: img.mushUrl,
        alt_text: undefined
      }));
    } else {
      // --- Use the helper function for S3 Upload Logic --- 
      if (options?.uploadToS3 !== false) {
 
        imagesWithMushUrl = await uploadImagesToS3AndAddUrls(itemData.images, itemData.sourceUrl);
 
      } else {
 
        // Skip S3 upload, just use scraped images with sourceUrl only
 
        imagesWithMushUrl = itemData.images;
 
      }
      // --- End S3 Upload Logic ---
    }

    // Construct the final Item object using the updated images array
    const finalItem: Item = {
      ...itemData,
      images: imagesWithMushUrl, // Use processed images
      status: 'ACTIVE'
    };

    return Utils.formatItem(finalItem);

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