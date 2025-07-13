import type { Page } from 'playwright';
import { Item, Image, Size } from '../db/types.js';
import * as Utils from '../db/db-utils.js';
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../lib/logger.js';

const log = logger.createContext('santa-brands.com');

export const SELECTORS = {
  productGrid: '.product-loop__item',
  productLinks: '.product-loop__title a',
  pagination: {
    type: 'numbered' as const,
    pattern: 'page={n}'
  },
  product: {
    title: 'h1.product__title',
    price: '.product__price-container .price-item--sale, .product__price-container .price-item--regular',
    images: '.product__image'
  }
};

/**
 * Gathers item URLs on the current page
 */
export async function getItemUrls(page: Page): Promise<Set<string>> {
  await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000 });
  const links = await page.$$eval(SELECTORS.productLinks, (els) =>
    els.map((e) => (e as HTMLAnchorElement).href)
  );
  return new Set(links);
}

/**
 * Paginates by incrementing the page number in the URL
 */
export async function paginate(page: Page): Promise<boolean> {
  // Get current page number and construct next page URL
  const currentUrl = page.url();
  const pageMatch = currentUrl.match(/[?&]page=(\d+)/);
  const currentPage = pageMatch ? parseInt(pageMatch[1]) : 1;
  const nextPage = currentPage + 1;

  // Construct next page URL
  let nextUrl = currentUrl;
  if (pageMatch) {
    nextUrl = nextUrl.replace(/([?&]page=)\d+/, `$1${nextPage}`);
  } else {
    nextUrl += (nextUrl.includes('?') ? '&' : '?') + `page=${nextPage}`;
  }

  // Try loading next page and check content
  try {
    const response = await page.goto(nextUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 10000
    });

    if (!response || !response.ok()) {
      log.normal(`   Pagination failed: Non-OK response for ${nextUrl} (status: ${response?.status()})`);
      return false;
    }

    // Check if the product grid is still present after navigation
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
    // Wait for critical elements
    await Promise.all([
      page.waitForSelector('.product-page', { timeout: 10000 }),
      page.waitForSelector('h1.product__title', { timeout: 10000 }),
      page.waitForSelector('.product__image', { timeout: 10000 })
    ]);

    // Define intermediate type matching evaluate return
    type ScrapedData = Omit<Item, 'images' | 'status'> & {
      images: Omit<Image, 'mushUrl'>[];
      color: string; // Make sure all fields from evaluate are here
    };

    // Extract product info from HTML
    const itemData: ScrapedData = await page.evaluate(() => {
      const title = document.querySelector('h1.product__title')?.textContent?.trim() || '';
      const priceText = document.querySelector('.price-item--regular')?.textContent?.trim() || '0';
      const currencySymbol = priceText.match(/[^\d\s.,]/)?.[0] || '$'; // Still extract symbol if needed
      const price = parseFloat(priceText.replace(/[^\d.,]/g, '').replace(/,/g, '')) || 0;

      // Intermediate image type
      type IntermediateImage = { sourceUrl: string; alt_text: string };

      const images: IntermediateImage[] = Array.from(document.querySelectorAll('.product__image'))
        .map(img => ({
          sourceUrl: (img as HTMLImageElement).src || '',
          alt_text: (img as HTMLImageElement).alt || ''
        }))
        .filter((img): img is IntermediateImage => {
          return typeof img.sourceUrl === 'string' && img.sourceUrl.length > 0 && !img.sourceUrl.startsWith('data:') && !img.sourceUrl.includes('blank.gif');
        })
        .map(img => ({
          ...img,
          sourceUrl: img.sourceUrl.startsWith('//') ? `https:${img.sourceUrl}` : img.sourceUrl // Ensure absolute URL
        }));

      const description = document.querySelector('.product-template__description')?.textContent?.trim() || '';

      const sizes: Size[] = Array.from(document.querySelectorAll('.swatches__form--label'))
        .map(label => ({
          size: label.textContent?.trim() || '',
          is_available: !label.closest('.swatches__swatch--regular')?.classList.contains('soldout')
        }))
        .filter(size => size.size !== '');

      const color = document.querySelector('#selected-option-2')?.textContent?.trim() || '';

      // Return object matching ScrapedData
      return {
        sourceUrl: window.location.href,
        product_id: document.querySelector('.product-page')?.getAttribute('data-product-id') || '',
        title,
        description,
        price,
        currency: 'USD',
        images, // Matches Omit<Image, 'mushUrl'>[]
        color,
        sizes,
        tags: [], // Add missing fields
        type: undefined,
        vendor: 'santa-brands' // Add missing fields
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
      images: imagesWithMushUrl,
      status: 'ACTIVE' // Assuming active if scraped
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
      vendor: 'santa-brands',
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