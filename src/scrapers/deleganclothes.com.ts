import type { Page } from 'playwright';
import type { Item, Image, Size } from '../types/item.js';
import * as Utils from "../db/db-utils.js";
import type { Scraper } from './types.js';
import { uploadImageUrlToS3 } from '../providers/s3.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import { logger } from '../utils/logger.js';

/**
 * Scraper for deleganclothes.com – uses page number pagination.
 *
 *  • getItemUrls(page) – extract ONLY the product URLs from the current DOM.
 *  • paginate(page)   – navigates to the next page by appending ?page=N to the URL.
 *    Returns `true` if products are found on the new page, `false` if the
 *    "No products found" message appears or no products are present.
 */

export const SELECTORS = {
  productGrid: '.product-card',
  productLinks: '.product-card a.product-card__link',
  product: {
    title: '.view-product-title a, .text-block p',
    price: '.add-to-cart-price, .price',
    comparePrice: '.compare-price, .compare-at-price',
    images: '.product-media__image',
    description: '.text-block p',
    productId: '[data-product-id]',
    sizes: '.variant-option__button-label',
    variantData: 'script[type="application/json"]'
  },
  pagination: {
    emptyMessage: '.main-collection-grid__empty'
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
  return new Set(links.map(link => new URL(link, page.url()).href)); // Ensure absolute URLs
}

// Store the last visited page number to track pagination state
let lastPageNumber = 1;

/**
 * Navigate to the next page by appending ?page=N to the URL.
 * Returns `true` if navigation succeeded and products were found, `false` if no more pages.
 */
export async function paginate(page: Page): Promise<boolean> {
  const log = logger.createContext('deleganclothes.paginate');
  
  try {
    // Increment to next page
    const nextPageNum = lastPageNumber + 1;
    
    // Build the URL with the next page number
    const currentUrl = new URL(page.url());
    currentUrl.searchParams.set('page', nextPageNum.toString());
    const nextUrl = currentUrl.toString();
    
    log.debug(`Navigating to page ${nextPageNum}`);
    log.debug(`URL: ${nextUrl}`);
    
    // Navigate to the next page
    await page.goto(nextUrl, { waitUntil: 'networkidle' });
    
    // Check if we hit the "No products found" message
    const hasEmptyMessage = await page.$(SELECTORS.pagination.emptyMessage);
    if (hasEmptyMessage) {
      log.debug(`Reached end of pagination at page ${nextPageNum} - found "No products found" message`);
      lastPageNumber = 1; // Reset for next scraping session
      return false;
    }
    
    // Check if there are any products on this page
    try {
      await page.waitForSelector(SELECTORS.productLinks, { timeout: 5000 });
      const productCount = await page.$$eval(SELECTORS.productLinks, elements => elements.length);
      
      if (productCount > 0) {
        log.debug(`Page ${nextPageNum} loaded with ${productCount} products (including any accumulated from previous pages)`);
        lastPageNumber = nextPageNum; // Update the last visited page
        return true;
      } else {
        log.debug(`Page ${nextPageNum} has no products`);
        lastPageNumber = 1; // Reset for next scraping session
        return false;
      }
    } catch (error) {
      // No products found on this page
      log.debug(`No products found on page ${nextPageNum}`);
      lastPageNumber = 1; // Reset for next scraping session
      return false;
    }
  } catch (error) {
    log.error('Error during pagination:', error);
    lastPageNumber = 1; // Reset for next scraping session
    return false;
  }
}

export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item[]> {
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
      // Extract title - try multiple selectors
      const title = document.querySelector('.view-product-title a')?.textContent?.trim() || 
                    document.querySelector('.text-block p')?.textContent?.trim() || '';
      
      // Extract product ID from data attribute
      const productId = document.querySelector('[data-product-id]')?.getAttribute('data-product-id') || '';

      // Price parsing - look for sale price and compare price
      let price = 0;
      let salePrice: number | undefined;
      
      // Check for price in add-to-cart button area
      const addToCartPrice = document.querySelector('.add-to-cart-price');
      if (addToCartPrice) {
        // Get the first text node which contains the current price
        const priceText = addToCartPrice.childNodes[0]?.textContent?.trim() || '';
        const comparePriceEl = addToCartPrice.querySelector('.compare-price');
        
        if (comparePriceEl) {
          // This is a sale item
          const saleText = priceText.replace(/[^\d.,]/g, '') || '0';
          salePrice = parseFloat(saleText.replace(',', '.')) || 0;
          const originalText = comparePriceEl.textContent?.replace(/[^\d.,]/g, '') || '0';
          price = parseFloat(originalText.replace(',', '.')) || 0;
        } else {
          // Regular price item
          const normalText = priceText.replace(/[^\d.,]/g, '') || '0';
          price = parseFloat(normalText.replace(',', '.')) || 0;
        }
      }
      
      // Fallback to other price selectors
      if (price === 0) {
        const priceEl = document.querySelector('.price');
        if (priceEl) {
          const priceText = priceEl.textContent?.replace(/[^\d.,]/g, '') || '0';
          price = parseFloat(priceText.replace(',', '.')) || 0;
        }
      }

      // Currency is EUR based on the HTML
      const currency = 'EUR';

      // Image extraction from product media
      let images: { sourceUrl: string; alt_text: string }[] = [];
      const imgEls = document.querySelectorAll('.product-media__image');
      images = Array.from(imgEls)
        .map(img => {
          const el = img as HTMLImageElement;
          // Get the highest resolution URL from data_max_resolution or fallback to src
          let url = el.getAttribute('data_max_resolution') || el.src;
          // Ensure URL has protocol
          if (url && !url.startsWith('http')) {
            url = 'https:' + url;
          }
          return { sourceUrl: url, alt_text: el.alt || '' };
        })
        .filter(i => i.sourceUrl && !i.sourceUrl.startsWith('data:') && !i.sourceUrl.includes('blank.gif') && !i.sourceUrl.includes('preview_images'));

      // Extract sizes from variant picker
      const sizeLabels = document.querySelectorAll('.variant-option__button-label');
      const sizes = Array.from(sizeLabels).map(label => {
        const input = label.querySelector('input[type="radio"]');
        const text = label.querySelector('.variant-option__button-label__text');
        const isAvailable = input?.getAttribute('data-option-available') === 'true';
        return {
          size: text?.textContent?.trim()?.toUpperCase() || '',
          is_available: isAvailable
        };
      }).filter(s => s.size);

      // Try to get variant data from script tag for more details
      const variantScripts = document.querySelectorAll('script[type="application/json"]');
      let variantData: any = null;
      for (const script of variantScripts) {
        try {
          const data = JSON.parse(script.textContent || '{}');
          if (data.id && data.title && data.price) {
            variantData = data;
            break;
          }
        } catch {}
      }

      // Extract description from text blocks
      const descriptionBlocks = document.querySelectorAll('.text-block p');
      let description = '';
      for (const block of descriptionBlocks) {
        const text = block.textContent?.trim() || '';
        if (text && text.length > 20 && !text.includes('€') && text !== title) {
          description = text;
          break;
        }
      }

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

    return [Utils.formatItem(finalItem)];
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