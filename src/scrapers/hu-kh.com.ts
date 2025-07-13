import type { Page } from 'playwright';
import { Item, Image, Size } from "../db/types.js";
import * as Utils from "../db/db-utils.js";
import { uploadImageUrlToS3 } from '../providers/s3.js';
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../lib/logger.js';

const log = logger.createContext('hu-kh.com');

export const SELECTORS = {
  productGrid: '.product-list.row',
  productLinks: '.product-card.catalog-product-card',
  pagination: {
    type: 'numbered' as const,
    nextButton: '.pages-item-next a',
    pattern: 'page={n}'
  },
  product: {
    title: '.product-name',
    price: '.product-price',
    comparePrice: '.old-product-price',
    productId: '[data-product-id]',
    images: '.gallery-view-slide img',
    sizes: '.product-option-item.real-option',
    description: '.product-description',
    composition: '#collapseThree .accordion-body',
    availability: '.product-option-unavailable'
  }
};

export async function getItemUrls(page: Page): Promise<Set<string>> {
  try {
    await page.waitForSelector(SELECTORS.productLinks, { timeout: 10000 });

    const urls = await page.evaluate(() => {
      const productCards = document.querySelectorAll('.product-card.catalog-product-card');
      return Array.from(productCards).map(card => {
        const link = card.querySelector('a.card-name.product-link');
        return (link as HTMLAnchorElement)?.href || null;
      }).filter((url): url is string => url !== null);
    });

    return new Set(urls);
  } catch (error) {
    // If we timeout waiting for products, throw error to treat as failure
    if (error instanceof Error && error.name === 'TimeoutError') {
      log.error(`getItemUrls: Timed out waiting for products on ${page.url()}. Error: ${error.message}`);
      throw new Error(`Timeout waiting for products: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Advances to the next numbered page by incrementing the `page` query param.
 * Returns `true` if the navigation succeeded AND there appear to be products
 * on the newly‑loaded page. Returns `false` when pagination is likely
 * finished (e.g. navigation failed or no products found).
 */
export async function paginate(page: Page): Promise<boolean> {
  // Ensure current page content has finished loading
  try {
    await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000 });
  } catch (_) {
    return false; // No grid => nothing to paginate
  }

  // Build next‑page URL by incrementing the `page` query parameter
  const currentUrl = page.url();
  const pageMatch = currentUrl.match(/[?&]page=(\d+)/);
  const currentPageNum = pageMatch ? parseInt(pageMatch[1], 10) : 1;
  const nextPageNum = currentPageNum + 1;

  let nextUrl: string;
  if (pageMatch) {
    nextUrl = currentUrl.replace(/([?&]page=)\d+/, `$1${nextPageNum}`);
  } else {
    nextUrl = currentUrl + (currentUrl.includes('?') ? '&' : '?') + `page=${nextPageNum}`;
  }

  try {
    const response = await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    if (!response || !response.ok()) {
      return false;
    }

    // Basic sanity check – make sure we still have a product list
    await page.waitForSelector(SELECTORS.productLinks, { timeout: 8000 });
    const urls = await getItemUrls(page);
    return urls.size > 0;
  } catch (_) {
    return false; // Treat any error as end‑of‑pagination
  }
}

// -----------------------
// Default export (Scraper)
// -----------------------

export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  const sourceUrl = page.url();
  try {
    // Page is already at sourceUrl, ensure content is loaded.
    await page.waitForSelector(SELECTORS.product.title, { timeout: 5000 });

    const title = await page.$eval(SELECTORS.product.title, el => el.textContent?.trim() || 'Unknown Product');
    const productId = await page.$eval(SELECTORS.product.productId, el => el.getAttribute('data-product-id') || 'unknown');

    // Extract regular price and sale price correctly
    const priceData = await page.$eval(SELECTORS.product.price, el => {
      const regularPriceEl = el.querySelector('.old-product-price');
      const fullText = el.textContent?.trim() || '0';

      // If there's a sale element (old-product-price), we have both regular and sale price
      if (regularPriceEl) {
        const regularText = regularPriceEl.textContent?.trim() || '';
        const saleText = fullText.replace(regularText, '').trim();

        return {
          regularPrice: parseFloat(regularText.replace(/[^\d.]/g, '')) || 0,
          salePrice: parseFloat(saleText.replace(/[^\d.]/g, '')) || 0,
          hasSale: true
        };
      }
      // If there's no sale element, the only price is the regular price
      else {
        return {
          regularPrice: parseFloat(fullText.replace(/[^\d.]/g, '')) || 0,
          salePrice: 0,
          hasSale: false
        };
      }
    });

    const imagesWithoutMushUrl: Image[] = await page.$$eval(SELECTORS.product.images, (imgs: Element[]) => {
      return imgs.map(img => ({
        sourceUrl: (img as HTMLImageElement).src,
        alt_text: (img as HTMLImageElement).alt
      }));
    });

    const validImages = imagesWithoutMushUrl.filter(img => img.sourceUrl && !img.sourceUrl.startsWith('data:'));

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

        imagesWithMushUrl = await uploadImagesToS3AndAddUrls(validImages, sourceUrl);

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        imagesWithMushUrl = validImages;

      }
    }
    // --- End S3 Upload Logic ---

    const sizes = await page.$$eval(SELECTORS.product.sizes, options => {
      return options.map(option => ({
        size: option.getAttribute('data-option-value-name') || '',
        is_available: !option.classList.contains('unavailable')
      })).filter(o => o.size);
    });

    const description = await page.$eval(SELECTORS.product.description, el =>
      el.textContent?.trim() || ''
    ).catch(() => '');

    const composition = await page.$eval(SELECTORS.product.composition, el =>
      el.textContent?.trim() || ''
    ).catch(() => '');

    const fullDescription = [description, composition].filter(Boolean).join('\n\n');

    const availability = await page.$eval(SELECTORS.product.availability, el =>
      el.textContent?.trim() || ''
    ).catch(() => '');

    const item: Item = {
      sourceUrl,
      product_id: productId,
      title,
      description: fullDescription,
      images: imagesWithMushUrl,
      price: priceData.hasSale ? priceData.regularPrice : priceData.regularPrice,
      sale_price: priceData.hasSale ? priceData.salePrice : undefined,
      currency: 'UAH',
      sizes,
      vendor: 'hu-kh'
    };

    return Utils.formatItem(item);
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