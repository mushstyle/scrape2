import { Page } from 'playwright';
import type { Item, Image, Size } from './types.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import { logger } from '../utils/logger.js';

const DOMAIN = 'example.com';

export async function getItemUrls(page: Page): Promise<Set<string>> {
  const itemUrls = new Set<string>();
  
  // Wait for product links
  await page.waitForSelector('a.product-link', { timeout: 10000 });
  
  const links = await page.locator('a.product-link').evaluateAll(elements =>
    elements.map(el => (el as HTMLAnchorElement).href)
  );
  
  for (const link of links) {
    if (link) {
      itemUrls.add(new URL(link, page.url()).href);
    }
  }
  
  return itemUrls;
}

export async function paginate(page: Page): Promise<boolean> {
  const nextButton = page.locator('a.next-page:not(.disabled)');
  
  if (await nextButton.isVisible()) {
    try {
      await nextButton.click({ timeout: 5000 });
      await page.waitForTimeout(2000);
      return true;
    } catch (error) {
      const log = logger.createContext('example.com');
      log.error(`Error clicking next page: ${error}`);
      return false;
    }
  }
  return false;
}

/**
 * Scrapes item details from a product page.
 * @param page - The Playwright page object already navigated to the product URL
 * @param options - Optional configuration for scraping behavior
 * @returns The scraped item data
 */
export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  // Default to scraping images if not specified
  const scrapeImages = options?.scrapeImages !== false;
  
  // Wait for main content
  await page.waitForSelector('h1.product-title', { timeout: 10000 });
  
  // Extract basic product information
  const title = await page.$eval('h1.product-title', el => el.textContent?.trim() || '').catch(() => '');
  const brand = await page.$eval('.product-brand', el => el.textContent?.trim() || '').catch(() => '');
  const description = await page.$eval('.product-description', el => el.textContent?.trim() || '').catch(() => '');
  
  // Extract price
  const priceText = await page.$eval('.product-price', el => el.textContent?.trim() || '').catch(() => '');
  const price = parseFloat(priceText.replace(/[^\d.]/g, '')) || undefined;
  
  // Extract sizes
  const sizes: Size[] = await page.$$eval('.size-option', elements =>
    elements.map(el => ({
      size: el.textContent?.trim() || '',
      is_available: !el.classList.contains('unavailable')
    }))
  ).catch(() => []);
  
  // Extract images conditionally
  let processedImages: Image[] = [];
  
  if (options?.existingImages && !scrapeImages) {
    // Use existing images from database - no scraping or S3 upload
    const log = logger.createContext(DOMAIN);
    log.verbose(`Using ${options.existingImages.length} existing images from database`);
    processedImages = options.existingImages.map(img => ({
      sourceUrl: img.sourceUrl,
      mushUrl: img.mushUrl,
      alt_text: undefined
    }));
  } else if (scrapeImages) {
    const log = logger.createContext(DOMAIN);
    log.verbose(`Scraping images for product`);
    
    const imagesRaw = await page.$$eval('.product-image img', (imgs) => {
      return imgs.map(img => ({
        sourceUrl: img.getAttribute('src') || '',
        alt: img.getAttribute('alt') || ''
      })).filter(img => img.sourceUrl);
    }).catch(() => []);
    
    // Upload images to S3 if we found any
    if (imagesRaw.length > 0) {
      if (options?.uploadToS3 !== false) {

        processedImages = await uploadImagesToS3AndAddUrls(imagesRaw, DOMAIN);

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        processedImages = imagesRaw;

      }
      const log = logger.createContext(DOMAIN);
      log.verbose(`Uploaded ${processedImages.length} images to S3`);
    }
  } else {
    const log = logger.createContext(DOMAIN);
    log.verbose(`Skipping image scraping (already exists in database)`);
  }
  
  // Extract product ID from URL
  const productId = page.url().split('/').pop()?.split('?')[0] || '';
  
  // Construct the item object
  const item: Item = {
    sourceUrl: page.url(),
    product_id: productId,
    title,
    vendor: brand,
    description,
    currency: 'USD',
    price: price || 0,
    sizes,
    images: processedImages,
    status: 'ACTIVE'
  };
  
  return item;
}

// For backward compatibility, export default object with all functions
export default {
  getItemUrls,
  paginate,
  scrapeItem
};