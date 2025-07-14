import type { Page, Browser } from 'playwright';
import { chromium } from 'playwright'; // chromium might still be needed if other funcs in this file were to use it, but not for scrapeItem
import { Item, Size, Image } from '../types/item.js"; // Import needed types
import * as Utils from "../db/db-utils.js";
import { uploadImageUrlToS3 } from '../providers/s3.js'; // Import S3 function
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js'; // Import the new helper
import type { Scraper } from './types.js';
import { logger } from '../lib/logger.js';

const log = logger.createContext('lecharmie.com');

export const SELECTORS = {
  productGrid: '.products',
  productLinks: '.woocommerce-loop-product__link',
  product: {
    title: 'h1.product_title',
    price: 'p.price .woocommerce-Price-amount', // General price selector
    salePrice: 'p.price ins .woocommerce-Price-amount',
    regularPrice: 'p.price del .woocommerce-Price-amount',
    currencySymbol: '.woocommerce-Price-currencySymbol',
    productIdContainer: 'div[data-product-id]',
    productIdAttr: 'data-product-id',
    productIdIdAttr: 'id',
    images: '.woocommerce-product-gallery__image img',
    imageSrcAttr: 'src', // Explicitly define attribute
    imageAltAttr: 'alt',  // Explicitly define attribute
    sizeSelectOptions: 'select[name="attribute_pa_size"] option',
    sizeButtons: 'button[data-attribute_name="attribute_pa_size"]',
    sizeButtonValueAttr: 'data-value', // Attribute for button size value
    descriptionShort: '.woocommerce-product-details__short-description',
    descriptionTab: '#tab-description',
    availability: 'p.availability',
    tags: '.tagged_as a'
  }
};

/**
 * Gathers item URLs from the current page.
 * @param page Playwright page object
 * @returns A set of product URLs
 */
export async function getItemUrls(page: Page): Promise<Set<string>> {
  try {
    await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000 });
    const urls = await page.evaluate((s) => {
      const links = document.querySelectorAll(s.productLinks);
      // Resolve relative URLs and filter empties
      return Array.from(links, link => (link as HTMLAnchorElement).href).filter(Boolean);
    }, SELECTORS);
    return new Set(urls as string[]);
  } catch (error) {
    log.debug(`Could not find product links (${SELECTORS.productLinks}) on ${page.url()}, returning empty set. Error: ${error}`);
    return new Set<string>();
  }
}

/**
 * Paginates by incrementing the page number in the URL path (/page/{n}/).
 * @param page Playwright page object
 * @returns `true` if pagination likely succeeded, `false` otherwise.
 */
export async function paginate(page: Page): Promise<boolean> {
  const currentUrl = page.url();
  // Robust check for /page/NUMBER/ pattern anywhere in the URL
  const pageMatch = currentUrl.match(/\/page\/(\d+)\/?/);
  const currentPage = pageMatch ? parseInt(pageMatch[1], 10) : 1;
  const nextPage = currentPage + 1;

  let nextUrl: string;
  if (pageMatch) {
    // Replace the existing /page/NUMBER/ segment
    nextUrl = currentUrl.replace(/\/page\/\d+\/?/, `/page/${nextPage}/`);
  } else {
    // Append /page/NUMBER/ before query string or hash, ensuring trailing slash before it
    const urlObject = new URL(currentUrl);
    const basePath = urlObject.pathname.endsWith('/') ? urlObject.pathname : `${urlObject.pathname}/`;
    nextUrl = `${urlObject.origin}${basePath}page/${nextPage}/${urlObject.search}${urlObject.hash}`;
  }

  log.debug(`   Navigating to next page: ${nextUrl}`);

  try {
    const response = await page.goto(nextUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 10000
    });

    if (!response || !response.ok() || response.status() === 404) {
      log.debug(`   Pagination failed or ended: Bad response for ${nextUrl} (Status: ${response?.status()})`);
      return false;
    }

    // Check for the presence of the product grid as a sign of a valid page
    await page.waitForSelector(SELECTORS.productGrid, { timeout: 5000 });
    log.debug(`   Pagination successful to page ${nextPage}`);
    return true;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Specific checks for common pagination end conditions
    if (errorMessage.includes('404') || errorMessage.includes('net::ERR_ABORTED') || errorMessage.includes('Timeout') || errorMessage.includes('selector') || errorMessage.includes('navigation failed')) {
      log.debug(`   Pagination likely ended or failed for ${nextUrl}: ${errorMessage}`);
      return false;
    } else {
      // Log unexpected errors but still treat as end of pagination for safety
      log.debug(`   Unexpected error during pagination to ${nextUrl}: ${errorMessage}`);
      return false;
    }
  }
}

// Helper function outside evaluate for parsing price strings
const parsePrice = (text: string | null | undefined): number | undefined => {
  if (!text) return undefined;
  // Remove currency symbols, thousand separators (commas or dots), then replace decimal comma with dot
  const cleaned = text
    .replace(/[^\d,.]/g, '') // Keep only digits, comma, dot
    .replace(/^(.*)[,.]([^,.]*)$/, (match, p1, p2) => p1.replace(/[,.]/g, '') + '.' + p2); // Handle decimal separator correctly
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? undefined : parsed;
};

export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  try {
    // The page is already navigated to the item URL by the caller.
    // log.debug(`Scraping data from already navigated page: ${page.url()}`); // Optional: confirm URL

    await page.waitForSelector(SELECTORS.product.title, { timeout: 10000 });

    // --- Step 1: Extract Raw Data (SUPER Simplified Evaluation) ---
    const rawData = await page.evaluate((s) => {
      // NO HELPER FUNCTIONS DEFINED INSIDE EVALUATE

      // Direct queries for text content
      const titleText = document.querySelector(s.product.title)?.textContent?.trim() || null;
      const descriptionShortText = document.querySelector(s.product.descriptionShort)?.textContent?.trim() || null;
      const descriptionTabText = document.querySelector(s.product.descriptionTab)?.textContent?.trim() || null;
      const availabilityText = document.querySelector(s.product.availability)?.textContent?.trim() || null;
      const regularPriceText = document.querySelector(s.product.regularPrice)?.textContent?.trim() || null;
      const salePriceText = document.querySelector(s.product.salePrice)?.textContent?.trim() || null;
      const fullPriceText = document.querySelector(s.product.price)?.textContent?.trim() || null; // Get main price text
      const currencySymbolText = document.querySelector(s.product.currencySymbol)?.textContent?.trim() || null;

      // Direct query for boolean
      const isOnSale = !!document.querySelector(s.product.salePrice);

      // Direct query for attributes
      const productIdEl = document.querySelector(s.product.productIdContainer);
      const productIdFromData = productIdEl?.getAttribute(s.product.productIdAttr) || null;
      const productIdFromId = productIdEl?.getAttribute(s.product.productIdIdAttr)?.replace('product-', '') || null;

      // Direct queries for lists of elements/attributes
      const imagesData = Array.from(document.querySelectorAll(s.product.images)).map(el => ({
        src: (el as HTMLImageElement).getAttribute(s.product.imageSrcAttr) || '',
        alt: (el as HTMLImageElement).getAttribute(s.product.imageAltAttr) || ''
      }));

      const sizeOptionData = Array.from(document.querySelectorAll(s.product.sizeSelectOptions)).map(el => ({
        value: (el as HTMLOptionElement).value || el.textContent?.trim() || '',
        disabled: (el as HTMLOptionElement).disabled,
        classList: '' // Select options don't usually indicate stock via class
      }));

      const sizeButtonData = Array.from(document.querySelectorAll(s.product.sizeButtons)).map(el => ({
        value: el.textContent?.trim() || el.getAttribute(s.product.sizeButtonValueAttr) || '',
        disabled: el.hasAttribute('disabled'),
        classList: el.className // Capture classes for stock check
      }));

      const tagTexts = Array.from(document.querySelectorAll(s.product.tags)).map(el => el.textContent?.trim() || '').filter(Boolean);

      return {
        sourceUrl: window.location.href,
        title: titleText,
        descriptionShort: descriptionShortText,
        descriptionTab: descriptionTabText,
        availabilityText: availabilityText,
        isOnSale: isOnSale,
        regularPriceText: regularPriceText,
        salePriceText: salePriceText,
        fullPriceText: fullPriceText,
        currencySymbolText: currencySymbolText,
        productId: productIdFromData || productIdFromId, // Combine fallbacks here
        images: imagesData,
        sizeOptions: sizeOptionData,
        sizeButtons: sizeButtonData,
        tagTexts: tagTexts,
      };
    }, SELECTORS); // Pass SELECTORS object

    // --- Step 2: Process Data in Node.js ---
    let product_id = rawData.productId || '';
    if (!product_id) {
      const pathParts = new URL(rawData.sourceUrl).pathname.split('/').filter(Boolean);
      product_id = `lecharmie-${pathParts[pathParts.length - 1] || Date.now()}`;
    }

    const title = rawData.title || 'Unknown Product';
    const description = [rawData.descriptionShort, rawData.descriptionTab].filter(Boolean).join('\n\n').trim();
    // const availability = rawData.availabilityText || ''; // Process if needed

    let price = 0;
    let sale_price: number | undefined = undefined;
    let currency = 'UAH'; // Default currency

    if (rawData.isOnSale) {
      price = parsePrice(rawData.regularPriceText) ?? 0;
      sale_price = parsePrice(rawData.salePriceText);
    } else {
      // Use the most prominent price if not on sale
      price = parsePrice(rawData.fullPriceText) ?? 0;
    }

    // Determine currency from symbol or default
    const currencySymbol = rawData.currencySymbolText;
    if (currencySymbol === '€') currency = 'EUR';
    else if (currencySymbol === '$') currency = 'USD';
    else if (currencySymbol === '₴') currency = 'UAH';
    // Use Utils.formatItem later to potentially map symbol to code if needed

    const imagesWithoutMushUrl: Image[] = rawData.images.map((imgData) => ({
      sourceUrl: imgData.src,
      alt_text: imgData.alt
    })).filter((img, index, self) =>
      img.sourceUrl &&
      !img.sourceUrl.startsWith('data:') && // Filter out base64 images
      self.findIndex(t => t.sourceUrl === img.sourceUrl) === index // Filter duplicates
    );

    // --- Use the helper function for S3 Upload Logic --- 
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

        imagesWithMushUrl = await uploadImagesToS3AndAddUrls(imagesWithoutMushUrl, rawData.sourceUrl);

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        imagesWithMushUrl = imagesWithoutMushUrl;

      }
    }
    // --- End S3 Upload Logic ---

    // Process sizes, combining options and buttons
    const processSizeData = (sizeDataList: typeof rawData.sizeOptions | typeof rawData.sizeButtons): Size[] => {
      return sizeDataList.map(data => ({
        size: data.value,
        is_available: !data.disabled && !data.classList.includes('disabled') && !data.classList.includes('out-of-stock')
      })).filter(size => size.size && size.size.toLowerCase() !== 'choose an option');
    };

    const sizesFromOptions = processSizeData(rawData.sizeOptions);
    const sizesFromButtons = processSizeData(rawData.sizeButtons);
    // Combine and remove duplicates (preferring button info if size matches)
    const combinedSizesMap = new Map<string, Size>();
    sizesFromOptions.forEach(s => combinedSizesMap.set(s.size, s));
    sizesFromButtons.forEach(s => combinedSizesMap.set(s.size, s)); // Overwrites option if button exists for same size
    const sizes = Array.from(combinedSizesMap.values());

    const tags = rawData.tagTexts;
    const vendor = 'lecharmie';

    // Construct the final Item object using the updated images array
    const item: Item = {
      sourceUrl: rawData.sourceUrl,
      product_id,
      title,
      description: description || undefined,
      vendor,
      images: imagesWithMushUrl, // Use processed images
      price,
      sale_price,
      currency,
      sizes: sizes.length > 0 ? sizes : undefined,
      tags: tags.length > 0 ? tags : undefined,
      status: 'ACTIVE',
    };

    return Utils.formatItem(item);

  } catch (error) {
    log.error(`Error scraping ${page.url()}:`, error); // Use page.url()
    // Re-throw or return a specific error structure if needed
    throw new Error(`Failed to scrape item at ${page.url()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper;