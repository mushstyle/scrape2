import type { Page } from 'playwright';
import { Item, Image, Size } from '../types/item.js";
import * as Utils from "../db/db-utils.js";
import type { Scraper } from './types.js';
import { uploadImageUrlToS3 } from '../providers/s3.js';
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js';
import { logger } from '../lib/logger.js';

/**
 * Scraper for deleganclothes.com – refactored to follow the Phase 3
 * interface described in plans/impl_scrape_refactor.md.
 *
 *  • getItemUrls(page) – extract ONLY the product URLs from the current DOM.
 *  • paginate(page)   – attempt to advance to the *next* page and return
 *    `true` if the navigation succeeded *and* the new page appears to
 *    contain at least one product URL; otherwise, returns `false`.
 *
 * NOTE: The previous implementation relied on module‑level `seenUrls`
 * and threw an `End of pagination` error; that pattern is no longer used.
 */

export const SELECTORS = {
  productGrid: 'ul.products',
  productLinks: 'ul.products li.product a.woocommerce-LoopProduct-link',
  product: {
    title: 'h1.product_title.entry-title',
    price: 'p.price',
    images: '.iconic-woothumbs-all-images-wrap, .iconic-woothumbs-images__slide img, .woocommerce-product-gallery__image img',
    description: '.woocommerce-product-details__short-description'
  },
  pagination: {
    nextButton: '.next.page-numbers'
  }
};

/**
 * Gather product URLs from the *current* DOM.
 */
export async function getItemUrls(page: Page): Promise<Set<string>> {
  try {
    await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000 });
    await page.waitForSelector(SELECTORS.productLinks, { timeout: 10000 });
  } catch (_) {
    // Either grid or links are missing – treat as empty page.
    return new Set();
  }

  const links = await page.$$eval(SELECTORS.productLinks, (elements) =>
    elements.map((el) => (el as HTMLAnchorElement).href)
  );
  return new Set(links);
}

/**
 * Advance to the next numbered page (`/page/{n}/`).
 * Returns `true` if the next page loaded AND appears to have at least
 * one product URL; otherwise returns `false` to signal the calling
 * script that pagination should stop.
 */
export async function paginate(page: Page): Promise<boolean> {
  const currentUrl = page.url();
  const match = currentUrl.match(/\/page\/(\d+)/);
  const currentPage = match ? parseInt(match[1], 10) : 1;
  const nextPage = currentPage + 1;

  // Build next‑page URL.
  const nextUrl = match || currentUrl.includes('/page/')
    ? currentUrl.replace(/(\/page\/)(\d+)/, `/page/${nextPage}`)
    : (currentUrl.endsWith('/')
      ? `${currentUrl}page/2/`
      : `${currentUrl}/page/2/`);

  try {
    const response = await page.goto(nextUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 10000 // Changed timeout
    });
    if (!response || !response.ok()) {
      return false;
    }
    const urls = await getItemUrls(page);
    return urls.size > 0;
  } catch (_) {
    return false; // treat navigation or selector errors as end‑of‑pagination
  }
}

export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  const sourceUrl = page.url();
  try {
    interface ImageData {
      full_src?: string;
      src?: string;
      url?: string;
      alt?: string;
    }

    // Define the item type more explicitly within the function scope for clarity
    type ScrapedItemData = Omit<Item, 'status' | 'mushUrl'> & { // Use Omit to exclude fields not directly scraped here
      images: { sourceUrl: string; alt_text: string }[]; // Ensure image structure matches
    };

    const itemData = await page.evaluate((SEL): ScrapedItemData => { // Type the return of evaluate
      const title = document.querySelector(SEL.product.title)?.textContent?.trim() || '';
      const productId = document.querySelector('form.variations_form.cart')?.getAttribute('data-product_id') || '';

      // Price parsing (handles regular vs sale price)
      let price = 0;
      let salePrice: number | undefined;
      const priceElement = document.querySelector(SEL.product.price);
      if (priceElement) {
        const delEl = priceElement.querySelector('del .woocommerce-Price-amount');
        const insEl = priceElement.querySelector('ins .woocommerce-Price-amount');
        if (insEl) {
          const saleText = insEl.textContent?.replace(/[^\d.,]/g, '') || '0';
          salePrice = parseFloat(saleText.replace(',', '.')) || 0;
          const originalText = delEl?.textContent?.replace(/[^\d.,]/g, '') || '0';
          price = parseFloat(originalText.replace(',', '.')) || 0;
        } else {
          const normalText = priceElement.querySelector('.woocommerce-Price-amount')?.textContent?.replace(/[^\d.,]/g, '') || '0';
          price = parseFloat(normalText.replace(',', '.')) || 0;
        }
      }

      // Detect currency symbol (€, ₴, etc.)
      let currency = 'EUR';
      const currencyMatch = priceElement?.textContent?.match(/[^\d\s.,]+/);
      if (currencyMatch) currency = currencyMatch[0];

      // Image extraction – try the JSON payload first.
      let images: { sourceUrl: string; alt_text: string }[] = [];
      const imageWrap = document.querySelector('.iconic-woothumbs-all-images-wrap');
      const dataDefault = imageWrap?.getAttribute('data-default');
      if (dataDefault) {
        try {
          const clean = dataDefault.replace(/\\"/g, '"');
          const json: ImageData[] = JSON.parse(clean);
          images = json
            .map(img => ({
              sourceUrl: img.full_src || img.src || img.url || '',
              alt_text: img.alt || ''
            }))
            .filter(i => i.sourceUrl && !i.sourceUrl.startsWith('data:') && !i.sourceUrl.includes('blank.gif'));
        } catch {
          // ignore JSON parse errors – fall back to DOM extraction
        }
      }

      if (images.length === 0) {
        const imgEls = document.querySelectorAll([
          '.iconic-woothumbs-images__slide img',
          '.woocommerce-product-gallery__image img',
          '.iconic-woothumbs-all-images-wrap img'
        ].join(','));
        images = Array.from(imgEls)
          .map(img => {
            const el = img as HTMLImageElement;
            const url = el.getAttribute('data-large_image') || el.getAttribute('data-src') || el.getAttribute('data-original') || el.src;
            return { sourceUrl: url, alt_text: el.alt || '' };
          })
          .filter(i => i.sourceUrl && !i.sourceUrl.startsWith('data:') && !i.sourceUrl.includes('blank.gif'));
      }

      // Sizes
      const sizeEls = document.querySelectorAll('li.thwvsf-wrapper-item-li.attribute_pa_size');
      const sizes = Array.from(sizeEls).map(el => ({
        size: (el.getAttribute('data-value') || '').toUpperCase(),
        is_available: true
      }));

      const description = document.querySelector(SEL.product.description)?.textContent?.trim() || '';

      // Construct the object matching ScrapedItemData
      const scrapedData: ScrapedItemData = {
        sourceUrl: location.href,
        product_id: productId,
        title,
        description,
        images,
        price,
        sale_price: salePrice,
        currency,
        sizes
      };
      return scrapedData; // Explicitly return the typed object
    }, SELECTORS);

    // Image handling with existing images support
    let imagesWithMushUrl: Image[];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
      logger.normal(`[deleganclothes.com] Using ${options.existingImages.length} existing images from database`);
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
      images: imagesWithMushUrl, // Use images processed by the helper
      status: 'ACTIVE',
      tags: itemData.tags || [],
      vendor: itemData.vendor || 'deleganclothes',
    };

    return Utils.formatItem(finalItem);
  } finally {
    // await browser.close(); // Browser lifecycle managed by the caller
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