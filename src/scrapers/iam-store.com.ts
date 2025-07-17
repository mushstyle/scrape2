import type { Page } from 'playwright';
import type { Item, Image, Size } from '../types/item.js';
import * as Utils from "../db/db-utils.js";
// Site config is now managed by SiteManager service
import { uploadImageUrlToS3 } from '../providers/s3.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('iam-store.com');

export const SELECTORS = {
  productGrid: '.product-grid',
  productLinks: '.product-tile',
  pagination: {
    type: 'scroll' as const,
    loadMoreIndicator: '.product-grid .product-tile'
  },
  product: {
    title: '.product__title',
    price: '[data-product-price]',
    comparePrice: '[data-compare-price]',
    productId: 'input[name="product-id"]',
    images: '.product__media img',
    sizes: 'select[name="options[Size]"] option',
    description: '.smart-tabs-content-block'
  }
};

export async function getItemUrls(page: Page): Promise<Set<string>> {
  await page.waitForSelector(SELECTORS.productLinks, { timeout: 5000 });

  const urls = await page.evaluate(() => {
    const productCards = document.querySelectorAll('.product-tile');
    const urls: string[] = [];

    productCards.forEach(card => {
      const link = card.querySelector('a[href*="/products/"]');
      if (link) {
        const url = new URL(link.getAttribute('href') || '', window.location.origin);
        urls.push(url.href);
      }
    });

    return urls;
  });

  return new Set(urls);
}

/**
 * Performs an incremental scroll‑load. Returns `true` if scrolling caused
 * additional products to appear; otherwise returns `false` to signal end of
 * pagination.
 */
export async function paginate(page: Page): Promise<boolean> {
  // Count products before scroll
  const beforeCount = await page.$$eval(SELECTORS.productLinks, els => els.length);

  // Scroll to bottom to trigger lazy loading / infinite scroll
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500); // give some time for network / DOM updates

  // Count products after scroll
  const afterCount = await page.$$eval(SELECTORS.productLinks, els => els.length);

  if (afterCount > beforeCount) {
    return true; // more products were loaded
  }

  // Fallback: if a load‑more indicator exists and is still visible we can try clicking it
  if (SELECTORS.pagination.loadMoreIndicator) {
    const loadMore = await page.$(SELECTORS.pagination.loadMoreIndicator);
    if (loadMore) {
      const visible = await loadMore.isVisible().catch(() => false);
      if (visible) {
        try {
          await loadMore.click({ timeout: 5000 });
          await page.waitForTimeout(1500);
          const newCount = await page.$$eval(SELECTORS.productLinks, els => els.length);
          return newCount > afterCount;
        } catch {
          /* ignore */
        }
      }
    }
  }

  return false; // No increase in items and no load‑more indicator
}

// -----------------------
// Default export (Scraper)
// -----------------------
/*
const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem 
};

export default scraper;
*/
export const scrapeItem = async (page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> => {
  try {
    // The page is already navigated to the sourceUrl by the caller
    // We still might want to ensure content is loaded, though the responsibility might shift.
    // For now, retain a waitForSelector to ensure the page is in the expected state.
    await page.waitForSelector(SELECTORS.product.title, { timeout: 10000 });
    const sourceUrl = page.url();

    // --- Data Extraction (Node.js side) ---
    const title = await page.$eval('.product__title', el => el.textContent?.trim() || 'Unknown Product');
    const productId = await page.$eval('input[name="product-id"]', el => (el as HTMLInputElement).value || 'unknown');
    const priceText = await page.$eval('[data-product-price]', el => el.textContent?.trim() || '0');
    const price = parseFloat(priceText.replace(/[^\d.]/g, '')) || 0;
    const comparePriceText = await page.$eval('[data-compare-price]', el => el.textContent?.trim() || '0').catch(() => '0');
    const comparePrice = parseFloat(comparePriceText.replace(/[^\d.]/g, '')) || 0;

    const finalPrice = comparePrice > 0 ? comparePrice : price;
    const salePrice = comparePrice > 0 && comparePrice !== price ? price : undefined;

    const currencyMatch = priceText.match(/[^\d\s.,]/);
    const currency = currencyMatch ? currencyMatch[0] : 'USD';

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
      // Normal image scraping flow
      const rawImages = await page.$$eval('.product__media img', (imgs) => {
        return imgs.map((img) => ({
          sourceUrl: (img as HTMLImageElement).src,
          alt_text: (img as HTMLImageElement).alt
        }));
      }).catch(() => []);
      const images: Image[] = rawImages;
      const validImages = images.filter(img => img.sourceUrl && !img.sourceUrl.startsWith('data:'));

      // --- Use the helper function for S3 Upload Logic --- 
      if (options?.uploadToS3 !== false) {
        log.debug(`Uploading ${validImages.length} images to S3...`);
        imagesWithMushUrl = await uploadImagesToS3AndAddUrls(validImages, sourceUrl);
      } else {
        // Skip S3 upload, just use scraped images with sourceUrl only
        log.debug(`Skipping S3 upload for ${validImages.length} images (uploadToS3=false)`);
        imagesWithMushUrl = validImages;
      }
      // --- End S3 Upload Logic ---
    }

    const rawSizes = await page.$$eval('select[name="options[Size]"] option', options => {
      return options.map((option) => ({
        size: (option as HTMLOptionElement).textContent?.trim() || '',
        is_available: !(option as HTMLOptionElement).disabled
      })).filter(o => o.size && o.size.toLowerCase() !== 'choose an option');
    }).catch(() => []);
    const sizes: Size[] = rawSizes;

    const description = await page.$$eval('.smart-tabs-content-block', blocks =>
      blocks.map(b => b.textContent?.trim()).filter(Boolean).join('\n\n')
    ).catch(() => '');

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
      vendor: 'iam-store',
    };

    return Utils.formatItem(item);
  } finally {
    // await browser.close(); // Browser lifecycle is managed by the caller
  }
};

// Moved from above
const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper;
