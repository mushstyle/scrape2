import type { Page } from 'playwright';
// import { chromium, Browser } from 'playwright'; // Removed Browser, chromium
import { Item, Size, Image } from "../db/types.js";
import * as Utils from "../db/db-utils.js";
import { getSiteConfig } from "../types/site-config.js";
import type { Scraper } from './types.js'; // Ensure Scraper type is imported
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js'; // Import S3 helper
import { logger } from '../lib/logger.js';

const log = logger.createContext('kobzart.com.ua');

export const SELECTORS = {
  productGrid: '.product-grid-item',
  productLinks: '.product-grid-item__content a[data-grid-link]',
  product: {
    title: '.product__title',
    price: '[data-product-price]',
    images: '.product__media img[data-product-image]'
  }
};

/**
 * Gathers item URLs from the current page 
 * @param page Playwright page object
 * @returns A set of product URLs
 */
export async function getItemUrls(page: Page): Promise<Set<string>> {
  try {
    await page.waitForSelector(SELECTORS.productLinks, { timeout: 10000 });
    const links = await page.$$eval(SELECTORS.productLinks, els =>
      els.map(e => (e as HTMLAnchorElement).href)
    );
    return new Set(links);
  } catch (error) {
    // If product links aren't found, it might be an empty page or end of results.
    log.error(`Could not find product links (${SELECTORS.productLinks}) on ${page.url()}, returning empty set.`);
    return new Set<string>(); // Return empty set instead of throwing
  }
}

/**
 * Paginates by incrementing the page number in the URL parameter.
 * Checks for page validity after navigation.
 * @param page Playwright page object
 * @returns `true` if pagination likely succeeded, `false` otherwise.
 */
export async function paginate(page: Page): Promise<boolean> {
  // Parse current page from query param
  const currentUrl = page.url();
  const match = currentUrl.match(/page=(\d+)/);
  const currentPage = match ? parseInt(match[1], 10) : 1;
  const nextPage = currentPage + 1;

  // Build next URL by replacing/adding the page number
  let nextUrl: string;
  if (currentUrl.includes('page=')) {
    nextUrl = currentUrl.replace(/page=\d+/, `page=${nextPage}`);
  } else if (currentUrl.includes('?')) {
    nextUrl = `${currentUrl}&page=${nextPage}`;
  } else {
    nextUrl = `${currentUrl}?page=${nextPage}`;
  }

  log.normal(`   Navigating to next page: ${nextUrl}`);

  try {
    // Navigate to the next page
    const response = await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });

    // Check if navigation was successful and the page seems valid
    if (!response || !response.ok()) {
      log.normal(`   Pagination failed: Bad response for ${nextUrl} (Status: ${response?.status()})`);
      return false;
    }

    // Optional: Check if the main product grid exists as a sign of a valid page
    await page.waitForSelector(SELECTORS.productGrid, { timeout: 5000 });
    log.normal(`   Pagination successful to page ${nextPage}`);
    return true; // Likely more pages or this is the last valid page

  } catch (error) {
    // Errors likely mean end of pagination (e.g., 404, timeout waiting for selector)
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.normal(`   Pagination likely ended or failed: ${errorMessage}`);
    return false;
  }
}

// Assuming Variant looks like: interface Variant { name: string; sourceUrl: string | null; }
// If Variant is not in types.ts, we might need to define it or adjust the Item type.
// For now, let's assume a basic Variant structure based on usage:
interface Variant { name: string; sourceUrl: string | null; }

// Helper functions (extractSizes, extractColor, extractImages)
function extractSizes(page: Page): Promise<Size[]> {
  return page.$$eval('input[name="options[Розмір]"]', (inputs) => {
    return inputs.map(input => ({
      size: input.getAttribute('value') || '',
      is_available: !input.classList.contains('sold-out')
    })).filter(item => item.size);
  }).catch((err) => {
    log.error('Error extracting sizes:', err);
    return [];
  });
}

function extractColor(page: Page): Promise<string> {
  return page.$eval('input[name="options[Колір]"][checked]',
    input => input.getAttribute('value') || ''
  ).catch((err) => {
    log.error('Could not extract color, might not exist:', err);
    return '';
  });
}

function extractImages(page: Page): Promise<Omit<Image, 'mushUrl'>[]> {
  return page.$$eval('.product__media img[data-product-image]', (imgs) => {
    type IntermediateImage = { sourceUrl: string; alt_text?: string };
    return imgs.map(img => {
      const src = (img as HTMLImageElement).src;
      const srcset = (img as HTMLImageElement).srcset;
      let bestUrl = src;
      if (srcset) {
        const sources = srcset.split(',').map(s => {
          const parts = s.trim().split(' ');
          return { sourceUrl: parts[0], width: parseInt(parts[1]) || 0 };
        }).sort((a, b) => b.width - a.width);
        if (sources.length > 0 && sources[0].sourceUrl) {
          bestUrl = sources[0].sourceUrl;
        }
      }

      return {
        sourceUrl: bestUrl.startsWith('//') ? 'https:' + bestUrl : bestUrl,
        alt_text: (img as HTMLImageElement).alt || ''
      } as IntermediateImage;
    })
      .filter((img): img is IntermediateImage => !!img.sourceUrl)
      .filter((img, index, self) =>
        index === self.findIndex(t => t.sourceUrl === img.sourceUrl)
      );
  }).catch((err) => {
    log.error('Error extracting images:', err);
    return [];
  });
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
    await page.waitForSelector('.product-page', { timeout: 10000 });

    const title = await page.$eval('.product__title', el => el.textContent?.trim() || '').catch(() => '');

    let price = 0;
    let currency = 'UAH';
    try {
      const priceText = await page.$eval('[data-product-price]', el => el.textContent?.trim() || '');
      const currencySymbol = priceText.match(/[^\d\s.,]/)?.[0] || '₴';
      const cleanedPriceText = priceText.replace(/[^\d.]/g, '');
      price = parseFloat(cleanedPriceText);
      if (currencySymbol === '₴') currency = 'UAH';
    } catch (e) {
      log.error('Could not parse price element.');
    }

    let description = '';
    try {
      description = await page.$eval('.product-description__content', el => el.textContent?.trim() || '');
    } catch (e) { log.error('Could not parse description.'); }

    let product_id = '';
    try {
      const productJsonText = await page.$eval('script[data-product-json]', el => el.textContent || '{}');
      const productJson = JSON.parse(productJsonText);
      product_id = productJson.variants?.[0]?.sku || productJson.id?.toString() || '';
    } catch (e) { log.error('Could not parse product JSON for ID/SKU.'); }

    if (!product_id) {
      const urlParts = sourceUrl.split('/');
      const slug = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2];
      product_id = `kobzart-${slug || Date.now()}`;
      log.error(`Using fallback product ID: ${product_id}`);
    }

    const [sizesData, colorsData, imagesData] = await Promise.all([
      extractSizes(page),
      extractColor(page),
      extractImages(page)
    ]);

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

        imagesWithMushUrl = await uploadImagesToS3AndAddUrls(imagesData, sourceUrl);

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        imagesWithMushUrl = imagesData;

      }
    }

    const finalItem: Item = {
      sourceUrl: sourceUrl,
      product_id,
      title,
      description,
      images: imagesWithMushUrl,
      price: isNaN(price) ? 0 : price,
      currency,
      sizes: sizesData.length > 0 ? sizesData : undefined,
      color: colorsData || undefined,
      vendor: 'Kobzart',
      status: 'ACTIVE'
    };

    return Utils.formatItem(finalItem);
  } catch (error) {
    log.error(`Error scraping item at ${sourceUrl}:`, error);
    throw error;
  }
}

// Define the default export for the scraper
const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper;