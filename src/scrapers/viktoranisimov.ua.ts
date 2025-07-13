import type { Page } from 'playwright';
// import { chromium } from 'playwright'; // No longer needed
import { Item, Image, Size } from '../db/types.js';
import * as Utils from '../db/db-utils.js';
// import { getSiteConfig } from '../diagnostics/site-utils.js'; // No longer needed
import { uploadImageUrlToS3 } from '../providers/s3.js';
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js';
import { logger } from '../lib/logger.js';

const log = logger.createContext('viktoranisimov.ua');

/**
 * Scraper for viktoranisimov.ua that uses incremental page numbers
 * and handles errors during pagination.
 */

export const SELECTORS = {
  productGrid: '.grid-wrapper.row-flex',
  productLinks: '.grid-block .product a',
  pagination: {
    type: 'numbered' as const,
    pattern: '/page/{n}'
  },
  product: {
    title: '.name',
    price: '.price',
    images: '.product-gallery .owl-item img',
    sizeSelect: '#groupSizes',
    sizeOptions: '#groupSizes option',
    colorLabel: '.article',
    description: '.product-description p',
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
    const links = await page.$$eval(SELECTORS.productLinks, els => {
      return Array.from(els).map(e => {
        const href = (e as HTMLAnchorElement).href;
        // href should already be absolute because of how Playwright handles it
        return href;
      });
    });
    return new Set(links);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`getItemUrls: Failed to get product links on ${page.url()}. Error: ${message}`);
    throw error; // Propagate error to treat as failure
  }
}

/**
 * Paginates by incrementing the /page/ segment in the URL, returns status.
 * @param page Playwright page object
 * @returns boolean indicating if pagination was successful and next page has content.
 */
export async function paginate(page: Page): Promise<boolean> {
  let nextUrl: string = page.url(); // Initialize for logging

  try {
    const currentUrl = page.url();
    const match = currentUrl.match(/\/page\/(\d+)/);
    const currentPage = match ? parseInt(match[1], 10) : 1;
    const nextPage = currentPage + 1;

    // Format next URL based on current page
    if (currentPage === 1) {
      // First page doesn't have /page/ in URL, so we need to add it
      // Ensure no trailing slash before appending /page/n
      const baseUrl = currentUrl.split('?')[0].replace(/\/$/, '');
      const query = currentUrl.split('?')[1];
      nextUrl = `${baseUrl}/page/${nextPage}${query ? '?' + query : ''}`;
    } else {
      // Replace current page number with next page number
      nextUrl = currentUrl.replace(`/page/${currentPage}`, `/page/${nextPage}`);
    }

    // Navigate to next page
    const response = await page.goto(nextUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 10000
    });

    // Check if navigation was successful (status code check)
    if (!response || response.status() >= 400) {
      log.normal(`   Pagination failed: Non-OK response for ${nextUrl} (status: ${response?.status()})`);
      return false;
    }

    // Check if we have products on this page (primary content check)
    await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000, state: 'visible' });
    log.normal(`   Successfully navigated to next page: ${nextUrl}`);
    return true; // Navigation succeeded, product grid found

  } catch (error) {
    // Check if the error is a timeout waiting for the product grid, indicating no more items
    if (error instanceof Error && error.message.includes('Timeout') && error.message.includes(SELECTORS.productGrid)) {
      log.normal(`   Pagination likely ended: Product grid selector (${SELECTORS.productGrid}) not found on ${nextUrl}`);
    } else {
      // Log other errors (e.g., navigation errors, non-404 status codes caught by goto)
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.normal(`   Pagination failed for ${nextUrl}: ${errorMessage}`);
    }
    return false; // Indicate failure
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
  // Removed verbose navigation log

  try {
    // Page is already at the correct URL. Ensure content is loaded.
    // Wait for product details to load
    await Promise.race([
      page.waitForSelector(SELECTORS.product.title, { timeout: 10000 })
        .catch(() => { }),
      // Wait for 5 seconds to allow the page to stabilize even if selectors aren't found
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);

    // Extract title
    const title = await page.$eval(SELECTORS.product.title, el => el.textContent?.trim() || '').catch(() => '');

    // Extract price
    const priceText = await page.$eval(SELECTORS.product.price, el => {
      const text = el.textContent?.trim() || '';
      return text.replace(/[^\d]/g, ''); // Remove non-digit characters
    }).catch(() => '0');
    const price = parseInt(priceText, 10) || 0;

    // Extract images and deduplicate them
    const imageUrls = await page.$$eval(SELECTORS.product.images, imgs => {
      const urls = imgs.map(img => (img as HTMLImageElement).src)
        .filter(src => src && src.trim().length > 0);
      // Remove duplicates - carousels often clone slides
      return [...new Set(urls)];
    }).catch(() => []);

    // Format images as objects with url property
    const imagesWithoutMushUrl: Image[] = imageUrls.map(imgUrl => ({ sourceUrl: imgUrl }));

    // Extract product ID from URL
    const productId = sourceUrl.split('/').pop() || '';

    // Extract color from article text
    const colorText = await page.$eval(SELECTORS.product.colorLabel, el => el.textContent?.trim() || '')
      .catch(() => '');
    const color = colorText.split(':')[1]?.trim();

    // Extract description using the defined selector
    const description = await page.$eval(SELECTORS.product.description, el => el.textContent?.trim() || '').catch(() => '');

    // Extract sizes - example for <select> dropdown
    const sizes: Size[] = await page.$$eval(SELECTORS.product.sizeSelect + ' option', options =>
      options.map(opt => ({
        size: (opt as HTMLOptionElement).value || '',
        is_available: !(opt as HTMLOptionElement).disabled
      }))
        .filter(s => s.size && s.size !== 'SIZE') // Filter out default/empty values
    ).catch(() => []);

    // --- Use the helper function for S3 Upload Logic --- 
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

        imagesWithMushUrl = await uploadImagesToS3AndAddUrls(imagesWithoutMushUrl, sourceUrl);

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        imagesWithMushUrl = imagesWithoutMushUrl;

      }
    }
    // --- End S3 Upload Logic ---

    // Construct the final Item object using the updated images array
    const finalItem: Item = {
      sourceUrl: sourceUrl, // Use sourceUrl from page.url()
      product_id: productId,
      title,
      description,
      images: imagesWithMushUrl, // Use processed images
      price,
      sale_price: undefined,
      currency: 'UAH',
      sizes: sizes.length > 0 ? sizes : undefined,
      color: color,
      vendor: 'Viktor Anisimov',
      tags: [],
      status: 'ACTIVE'
    };

    return Utils.formatItem(finalItem);

  } catch (error) {
    log.error(`Error scraping item ${sourceUrl}:`, error);
    throw error; // Re-throw
  } finally {
    // await browser.close(); // Browser lifecycle managed by the caller
  }
}

// ... scraper export ...