import { Page } from 'playwright';
import { Item, Image, Size } from '../types/item.js';
import * as Utils from '../db/db-utils.js';
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../lib/logger.js';

const log = logger.createContext('wonder-gallery.com');

export const SELECTORS = {
  productGrid: '.product-grid.active',
  productLinks: '.product-grid.active .product .image a',
  pagination: {
    type: 'numbered' as const,
    pattern: 'page={n}'
  },
  product: {
    title: 'h1#title-page',
    price: '.price, .price .price-new, .price #price-old',
    images: '.popup-gallery .thumbnails ul li a.popup-image',
    productId: 'input[name="product_id"]',
    description: '#tab-description',
    colorAttributeTable: '#tab-attribute table.attribute',
    sizesSelect: 'select[name^="option"]:not([name*="recurring"])'
  }
};

/**
 * Gathers item URLs on the current page
 */
export async function getItemUrls(page: Page): Promise<Set<string>> {
  await page.waitForSelector(SELECTORS.productLinks, { timeout: 10000 });
  const links = await page.$$eval(SELECTORS.productLinks, els =>
    els.map(e => (e as HTMLAnchorElement).href).filter(Boolean)
  );
  return new Set(links);
}

/**
 * Paginates by incrementing the page number in the URL, returns status.
 */
export async function paginate(page: Page): Promise<boolean> {
  let nextUrl: string = page.url(); // Initialize for logging

  try {
    // Parse current page number
    const currentUrl = page.url();
    const match = currentUrl.match(/page=(\d+)/);
    const currentPage = match ? parseInt(match[1], 10) : 1;
    const nextPage = currentPage + 1;

    // Construct next page URL
    let baseUrl = currentUrl;
    if (match) {
      nextUrl = baseUrl.replace(/page=\d+/, `page=${nextPage}`);
    } else {
      const separator = baseUrl.includes('?') ? '&' : '?';
      nextUrl = `${baseUrl}${separator}page=${nextPage}`;
    }

    // Navigate to the next page
    const response = await page.goto(nextUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 10000 // Increased timeout
    });

    if (!response || !response.ok()) {
      log.normal(`   Pagination failed: Non-OK response for ${nextUrl} (status: ${response?.status()})`);
      return false;
    }

    // Check if the product grid is still present after navigation
    // Need to handle potential multiple grids, use the 'active' one
    await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000, state: 'visible' });
    log.normal(`   Successfully navigated to next page: ${nextUrl}`);
    return true; // Navigation succeeded, potentially more items

  } catch (error) {
    // Check if the error is a timeout waiting for the product grid, which indicates no more items
    if (error instanceof Error && error.message.includes('Timeout') && error.message.includes(SELECTORS.productGrid)) {
      log.normal(`   Pagination likely ended: Product grid selector (${SELECTORS.productGrid}) not found on ${nextUrl}`);
    } else {
      // Log other errors (e.g., navigation errors)
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.normal(`   Pagination failed for ${nextUrl}: ${errorMessage}`);
    }
    return false; // Navigation or content check failed
  }
}

/**
 * Scrapes item details from the provided URL
 */
export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  const sourceUrl = page.url();
  try {
    // Page is already at sourceUrl, ensure content is loaded.
    await page.waitForSelector('.product-info', { timeout: 10000 });

    // Define intermediate type based on evaluate return
    type ScrapedData = Omit<Item, 'images' | 'status' | 'vendor'> & {
      images: Omit<Image, 'mushUrl'>[];
      color: string | undefined;
    };

    const itemData: ScrapedData = await page.evaluate(() => {
      const title = document.querySelector('span[itemprop="name"]')?.textContent?.trim() || '';
      const product_id = document.querySelector('input[name="product_id"]')?.getAttribute('value') || '';

      let price = 0;
      const priceElement = document.querySelector('#price-old, .price-new');
      if (priceElement) {
        const priceText = priceElement.textContent?.trim() || '';
        const sanitized = priceText.replace(/[^\d.,]/g, '').replace(/,/g, '');
        price = parseFloat(sanitized) || 0;
      }

      // Intermediate image type
      type IntermediateImage = { sourceUrl: string; alt_text: string };

      const images: IntermediateImage[] = Array.from(document.querySelectorAll('.thumbnails a.popup-image'))
        .map(el => ({
          sourceUrl: (el as HTMLAnchorElement).href || '',
          alt_text: el.getAttribute('title') || ''
        }))
        .filter((img): img is IntermediateImage => {
          return typeof img.sourceUrl === 'string' && img.sourceUrl.length > 0 && !img.sourceUrl.includes('data:') && !img.sourceUrl.includes('blank.gif');
        });

      const description = document.querySelector('#tab-description')?.textContent?.trim() || '';

      const sizes: Size[] = Array.from(document.querySelectorAll('select[name^="option"] option'))
        .filter(opt => opt.getAttribute('value'))
        .map(opt => {
          const isDisabled = opt.hasAttribute('disabled') && (opt.getAttribute('disabled') === 'true' || opt.getAttribute('disabled') === '');
          return {
            size: opt.textContent?.trim() || '',
            is_available: !isDisabled
          };
        });

      let color: string | undefined = undefined;
      const colorMatch = description.match(/Color:\s*(\w+)/i);
      if (colorMatch) {
        color = colorMatch[1];
      }

      // Return object matching ScrapedData
      return {
        sourceUrl: window.location.href,
        product_id,
        title,
        description,
        images, // Omit<Image, 'mushUrl'>[]
        price,
        currency: 'UAH',
        color,
        sizes,
        tags: [], // Add missing field
        type: undefined // Add missing field
      };
    });

    // --- S3 Image Upload Step ---
    // Image handling with existing images support
    let imagesWithMushUrl: Image[];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
      log.normal(`Using ${options.existingImages.length} existing images from database`);
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
    // --- End S3 Upload Step ---

    // Construct final Item
    const finalItem: Item = {
      ...itemData,
      images: imagesWithMushUrl, // Use processed images
      vendor: 'wonder-gallery', // Add vendor
      status: 'ACTIVE' // Assume active
    };

    return Utils.formatItem(finalItem);

  } catch (error) {
    log.error(`Error scraping item at ${sourceUrl}:`, error);
    // Return minimal error item matching Item type
    return Utils.formatItem({
      sourceUrl: sourceUrl,
      product_id: '',
      title: `Error scraping item`,
      description: error instanceof Error ? error.message : String(error),
      status: undefined,
      vendor: 'wonder-gallery',
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

// Define Scraper object after scrapeItem function
const scraper: Scraper = {
  getItemUrls,
  paginate,
  scrapeItem
};

export default scraper;