import type { Page } from 'playwright';
import type { Item, Image, Size } from '../types/item.js';
import * as Utils from '../db/db-utils.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('total-white.com');

export const SELECTORS = {
  productItem: '.product-item',
  productGrid: '.product-item',
  productLinks: 'a.product-link.product-link--image',
  pagination: {
    type: 'numbered' as const
  },
  product: {
    title: '.product__title',
    salePrice: '.product__price--sale .money',
    comparePrice: '.product__price--strike .money',
    normalPrice: '.product__price .money', // fallback if no sale
    images: '.product__slide img[data-product-image]',
    description: '.tab-content__entry',
    productId: 'input[name="product-id"]',
    sizeOptions: 'input[name^="options["]',
    productJson: 'script[data-product-json]'
  }
};

/**
 * Scrapes all product links on the current listing page
 */
export async function getItemUrls(page: Page): Promise<Set<string>> {
  await page.waitForSelector(SELECTORS.productItem, { timeout: 10000 });
  const urls = await page.evaluate((selector) => {
    const anchors = document.querySelectorAll(selector);
    const results: string[] = [];
    anchors.forEach(a => {
      if ((a as HTMLAnchorElement).href) {
        const url = new URL((a as HTMLAnchorElement).href, window.location.origin);
        results.push(url.href);
      }
    });
    return results;
  }, SELECTORS.productLinks);
  return new Set(urls);
}

/**
 * Paginates by incrementing the ?page= param, returns status
 */
export async function paginate(page: Page): Promise<boolean> {
  let nextUrl: string = page.url(); // Initialize for error logging

  try {
    // Attempt to build next page URL
    const currentUrl = page.url();
    const match = currentUrl.match(/[?&]page=(\d+)/);
    const currentPage = match ? parseInt(match[1], 10) : 1;
    const nextPage = currentPage + 1;

    // Assign calculated nextUrl
    if (match) {
      nextUrl = currentUrl.replace(/([?&]page=)\d+/, `$1${nextPage}`);
    } else {
      nextUrl = currentUrl + (currentUrl.includes('?') ? '&' : '?') + `page=${nextPage}`;
    }

    // Navigate to the next page
    const response = await page.goto(nextUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 10000 // Increased timeout
    });

    if (!response || !response.ok()) {
      log.debug(`   Pagination failed: Non-OK response for ${nextUrl} (status: ${response?.status()})`);
      return false;
    }

    // Check if the product grid is still present after navigation
    await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000, state: 'visible' });
    log.debug(`   Successfully navigated to next page: ${nextUrl}`);
    return true; // Navigation succeeded, potentially more items

  } catch (error) {
    // Check if the error is a timeout waiting for the product grid, which indicates no more items
    if (error instanceof Error && error.message.includes('Timeout') && error.message.includes(SELECTORS.productGrid)) {
      log.debug(`   Pagination likely ended: Product grid selector (${SELECTORS.productGrid}) not found on ${nextUrl}`);
    } else {
      // Log other errors (e.g., navigation errors)
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.debug(`   Pagination failed for ${nextUrl}: ${errorMessage}`);
    }
    return false; // Navigation or content check failed
  }
}

/**
 * Scrapes a single product detail page
 */
export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  const sourceUrl = page.url();
  try {
    // Page is already at sourceUrl, ensure content is loaded.
    await page.waitForSelector(SELECTORS.product.title, { timeout: 10000 });

    // Define intermediate type for evaluate return
    type ScrapedData = Omit<Item, 'images' | 'status' | 'vendor'> & {
      images: Omit<Image, 'mushUrl'>[];
    };

    const itemData: ScrapedData = await page.evaluate((SEL) => {
      const product_id = document.querySelector(SEL.product.productId)?.getAttribute('value') || '';
      const title = document.querySelector(SEL.product.title)?.textContent?.trim() || '';

      // Price handling
      let sale_price: number | undefined;
      let price = 0;
      const salePriceEl = document.querySelector(SEL.product.salePrice);
      const comparePriceEl = document.querySelector(SEL.product.comparePrice);
      const normalPriceEl = document.querySelector(SEL.product.normalPrice);

      if (salePriceEl) {
        sale_price = parseFloat(salePriceEl.textContent?.replace(/[^\d.]/g, '') || '0');
      }
      if (comparePriceEl) {
        price = parseFloat(comparePriceEl.textContent?.replace(/[^\d.]/g, '') || '0');
      } else if (!salePriceEl && normalPriceEl) {
        price = parseFloat(normalPriceEl.textContent?.replace(/[^\d.]/g, '') || '0');
      }

      let currency = 'USD';
      const priceText = salePriceEl?.textContent || comparePriceEl?.textContent || normalPriceEl?.textContent || '';
      const currencyMatch = priceText.match(/[^\d\s.,]+/);
      if (currencyMatch) {
        currency = currencyMatch[0];
      }

      // Intermediate type for images extracted in evaluate
      type IntermediateImage = { sourceUrl: string; alt_text: string };
      let images: IntermediateImage[] = [];

      // --- Try extracting images from JSON first ---
      try {
        const jsonScript = document.querySelector(SEL.product.productJson);
        if (jsonScript?.textContent) {
          const productData = JSON.parse(jsonScript.textContent);
          if (productData?.media && Array.isArray(productData.media)) {
            images = productData.media
              .filter((media: any) => media.media_type === 'image' && media.src) // Filter for images with src
              .map((media: any) => {
                let imageUrl = media.src;
                // Prepend https: if the URL is protocol-relative
                if (imageUrl.startsWith('//')) {
                  imageUrl = 'https:' + imageUrl;
                }
                return {
                  sourceUrl: imageUrl,
                  alt_text: media.alt || title || '' // Use title as fallback alt
                };
              });
          }
        }
      } catch (e) {
        // Failed to parse product JSON for images
        images = []; // Clear images if JSON parsing failed
      }

      // --- Fallback to extracting images from slide elements if JSON failed ---
      if (images.length === 0) {
        log.debug('Falling back to extracting images from slide elements (srcset)');
        const slideEls = document.querySelectorAll(SEL.product.images);
        images = Array.from(slideEls).map(img => {
          const srcset = img.getAttribute('data-srcset') || img.getAttribute('srcset');
          if (!srcset) return null;

          const srcsetParts = srcset.split(',')
            .map(part => {
              const [url, size] = part.trim().split(' ');
              return { sourceUrl: url.split('?')[0], width: parseInt(size || '0') };
            })
            .sort((a, b) => b.width - a.width);

          if (!srcsetParts.length || !srcsetParts[0].sourceUrl) return null;

          let imageUrl = srcsetParts[0].sourceUrl;
          if (imageUrl.startsWith('//')) {
            imageUrl = 'https:' + imageUrl;
          }

          return {
            sourceUrl: imageUrl,
            alt_text: img.getAttribute('alt') || ''
          };
        }).filter((img): img is IntermediateImage => img !== null && typeof img.sourceUrl === 'string');
      }

      // Remove duplicates (applies to either method)
      const uniqueImages = images.filter((img, idx, arr) =>
        img && arr.findIndex(t => t?.sourceUrl === img.sourceUrl) === idx
      );

      const description = document.querySelector(SEL.product.description)?.textContent?.trim() || '';

      // Sizes
      const sizeEls = document.querySelectorAll(SEL.product.sizeOptions);
      const sizes: Size[] = Array.from(sizeEls).map(el => {
        const input = el as HTMLInputElement;
        const sizeVal = input.value || '';
        const isDisabled = input.disabled;
        return {
          size: sizeVal,
          is_available: !isDisabled
        };
      }).filter(s => s.size);

      // Return object matching ScrapedData
      return {
        sourceUrl: window.location.href,
        product_id,
        title,
        description,
        images: uniqueImages, // Use the extracted images (JSON or fallback)
        price,
        sale_price,
        currency,
        sizes,
        tags: [],
        type: undefined
      };
    }, SELECTORS);

    // --- S3 Image Upload Step ---
    // Image handling with existing images support
    let imagesWithMushUrl: Image[];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
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
    // --- End S3 Upload Step ---

    // Construct final Item object
    const finalItem: Item = {
      ...itemData,
      images: imagesWithMushUrl, // Use processed images
      vendor: 'total-white',
      status: 'ACTIVE'
    };

    return Utils.formatItem(finalItem);

  } catch (error) {
    log.error(`Error scraping item at ${sourceUrl}:`, error);
    // Return minimal error item
    return Utils.formatItem({
      sourceUrl: sourceUrl,
      product_id: '',
      title: `Error scraping item`,
      description: error instanceof Error ? error.message : String(error),
      status: undefined,
      vendor: 'total-white',
      price: 0,
      currency: 'XXX',
      images: [],
      sizes: [],
      tags: [],
      type: undefined
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