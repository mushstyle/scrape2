import type { Page } from 'playwright';
import type { Item, Image, Size } from '../types/item.js';
import * as Utils from "../db/db-utils.js";
import type { Scraper } from './types.js'; // Import the Scraper type
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js'; // Import S3 helper
import { logger } from '../utils/logger.js';

const log = logger.createContext('ivaclothe.com');

/**
 * Scraper for ivaclothe.com, updated to the new pagination interface
 * and using selectors based on the latest provided DOM structure.
 * This site uses simple numbered pages (?page={n}).
 */

export const SELECTORS = {
  productGrid: '#product-grid',
  productLinks: 'div.card__container a[href*="/products/"]',
  pagination: {
    type: 'numbered' as const,
    pattern: 'page={n}'
  },
  product: {
    infoContainer: '.product__info-container',
    title: '.product__info-container h1', // Simplified selector
    priceContainer: '.price',
    price: '.price__regular .price-item--regular',
    salePrice: '.price--on-sale .price-item--sale',
    comparePrice: '.price--on-sale s.price-item--regular',
    images: '.product__media-item img',
    description: '.product__description',
    vendor: '.product__text.caption-with-letter-spacing a',
    productId: 'input[name="id"]',
    variantDataScript: 'variant-selects script[type="application/json"]',
    sizeInputs: 'input[name="Size"]',
  }
};


/**
 * Helper function to parse price strings like "₴4,400.00"
 * Defined outside scrapeItem to be passed as a string.
 * @param priceString The string containing the price
 * @returns The parsed price as a number, or 0 if parsing fails.
 */
const parsePrice = (priceString: string | null | undefined): number => {
  if (!priceString) return 0;
  // Remove currency symbol (₴, $, € etc.), spaces, and thousands separators (like comma)
  const cleanedString = priceString.replace(/[^\d.]/g, '');
  // Assumes '.' is the decimal separator. If ',' is used, replace it: .replace(',', '.')
  return parseFloat(cleanedString) || 0;
};


/**
 * Gathers item URLs from the current page state.
 */
export async function getItemUrls(page: Page): Promise<Set<string>> {
  try {
    // First check if grid exists at all (don't require visible)
    const gridExists = await page.$(SELECTORS.productGrid);
    if (!gridExists) {
      log.debug(`getItemUrls: No product grid found on ${page.url()}`);
      return new Set();
    }
    
    // Quick check if the grid is empty/hidden before waiting for products
    const gridHasContent = await page.evaluate((gridSelector) => {
      const grid = document.querySelector(gridSelector);
      if (!grid) return false;
      // Check if grid has actual product content (not just whitespace)
      const hasProducts = grid.querySelectorAll('a[href*="/products/"]').length > 0;
      const hasChildren = grid.children.length > 0;
      const hasText = grid.textContent?.trim() !== '';
      return hasProducts || (hasChildren && hasText);
    }, SELECTORS.productGrid);
    
    if (!gridHasContent) {
      log.debug(`getItemUrls: Product grid is empty on ${page.url()}`);
      return new Set();
    }
    
    // Only wait for selector visibility if we know there's content
    await page.waitForSelector(SELECTORS.productGrid, { timeout: 5000, state: 'visible' });
    await page.waitForFunction((selector) => {
      return document.querySelectorAll(selector).length > 0;
    }, SELECTORS.productLinks, { timeout: 10000 });

  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('Timeout')) {
      log.error(`getItemUrls: Timed out waiting for product links on ${page.url()}. Error: ${message}`);
      throw new Error(`Timeout waiting for product links: ${message}`);
    } else {
      log.debug(`getItemUrls: Could not find product grid or links on ${page.url()}. Error: ${message}. Returning empty set.`);
    }
    return new Set();
  }

  const urls = await page.evaluate((productLinksSelector) => {
    const productLinks = Array.from(document.querySelectorAll(productLinksSelector));
    return productLinks.map(link => {
      const href = link.getAttribute('href');
      return (href && href.includes('/products/')) ? new URL(href, window.location.origin).href : null;
    }).filter(url => url !== null);
  }, SELECTORS.productLinks);

  log.debug(`getItemUrls: Found ${urls.length} URLs on ${page.url()}.`);
  return new Set(urls as string[]);
}

/**
 * Attempts to advance pagination by navigating to the next page number in the URL.
 */
export async function paginate(page: Page): Promise<boolean> {
  const currentUrl = page.url();
  const url = new URL(currentUrl);
  const currentPage = parseInt(url.searchParams.get('page') || '1', 10);
  const nextPage = currentPage + 1;

  url.searchParams.set('page', nextPage.toString());
  const nextUrl = url.toString();

  try {
    const response = await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    if (!response || !response.ok()) {
      log.debug(`paginate: Failed to load ${nextUrl} (status: ${response?.status()}). Assuming end of pagination.`);
      return false;
    }

    let urlsOnNextPage: Set<string>;
    try {
      urlsOnNextPage = await getItemUrls(page);
      if (urlsOnNextPage.size === 0) {
        log.debug(`paginate: Navigated to ${nextUrl}, but found 0 product URLs. Assuming end of useful pagination.`);
        return false;
      }
    } catch (e) {
      // Re-throw timeout errors to ensure they're treated as failures
      if (e instanceof Error && e.message.includes('Timeout')) {
        throw e;
      }
      // For other errors, log and return false
      log.debug(`paginate: Error checking URLs on ${nextUrl}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }

    log.debug(`paginate: Successfully navigated to ${nextUrl} and found ${urlsOnNextPage.size} product URLs.`);
    return true;

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.debug(`paginate: Error navigating to or verifying ${nextUrl}: ${message}. Assuming end of pagination.`);
    return false;
  }
}


/**
 * Scrape a product page from ivaclothe.com
 */
export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  const sourceUrl = page.url();
  try {
    // Page is already at sourceUrl. Caller should ensure networkidle if needed.
    // await page.goto(sourceUrl, { waitUntil: 'networkidle' }); // Removed goto

    // Extract product details from the page
    // Define an intermediate type for clarity before S3 processing
    type ScrapedData = Omit<Item, 'images' | 'status'> & {
      images: Omit<Image, 'mushUrl'>[]; // Images before S3 upload
    };

    const itemData: ScrapedData = await page.evaluate(() => {
      // Product ID - extract from variant data or URL
      const productIdMatch = window.location.pathname.match(/\/products\/[^/]+-(\d+)/) || [];
      const productId = document.querySelector('input[name="product-id"]')?.getAttribute('value') || productIdMatch[1] || '';

      // Title
      const title = document.querySelector('h1')?.textContent?.trim() ||
        document.querySelector('.product__title h2')?.textContent?.trim() || '';

      // Price and Sale Price (extracting logic from the original evaluate block)
      let price = 0;
      let salePrice = undefined;
      const onSaleDiv = document.querySelector('.price--on-sale');
      if (onSaleDiv) {
        const strikethroughPriceElement = document.querySelector('.price__sale s.price-item--regular');
        if (strikethroughPriceElement) {
          const regularPriceText = strikethroughPriceElement.textContent?.trim() || '';
          const regularPriceMatch = regularPriceText.match(/₴([\d,]+(\.\d+)?)/) || [];
          if (regularPriceMatch[1]) {
            price = Number(regularPriceMatch[1].replace(/,/g, ''));
          }
        }
        const salePriceElement = document.querySelector('.price-item--sale');
        if (salePriceElement) {
          const salePriceText = salePriceElement.textContent?.trim() || '';
          const salePriceMatch = salePriceText.match(/₴([\d,]+(\.\d+)?)/) || [];
          if (salePriceMatch[1]) {
            salePrice = Number(salePriceMatch[1].replace(/,/g, ''));
          }
        }
      } else {
        const priceElement = document.querySelector('.price-item--regular');
        if (priceElement) {
          const priceText = priceElement.textContent?.trim() || '';
          const priceMatch = priceText.match(/₴([\d,]+(\.\d+)?)/) || [];
          if (priceMatch[1]) {
            price = Number(priceMatch[1].replace(/,/g, ''));
          }
        }
      }
      const currency = 'UAH'; // Currency seems fixed

      // Description
      const description = document.querySelector('.product__description')?.textContent?.trim() || '';

      // Vendor
      const vendor = document.querySelector('.product__text')?.textContent?.trim() || '';

      // Images (extracting logic from the original evaluate block)
      const imageElements = document.querySelectorAll('.product__media-item img');
      const uniqueImageUrls = new Set<string>();
      // Define intermediate type for image data gathered here
      type IntermediateImage = { sourceUrl: string; alt_text: string };

      const images: IntermediateImage[] = Array.from(imageElements)
        .map(img => {
          const imgElement = img as HTMLImageElement;
          const url = imgElement.src.split('?')[0];
          if (url && !uniqueImageUrls.has(url)) {
            uniqueImageUrls.add(url);
            return {
              sourceUrl: url,
              alt_text: imgElement.alt || '' // Guaranteed string
            };
          }
          return null;
        })
        // Filter out nulls using a type guard for the intermediate type
        .filter((img): img is IntermediateImage => img !== null);

      // Sizes (extracting logic from the original evaluate block)
      const sizeInputs = document.querySelectorAll('input[name="Size"]');
      const sizes: Size[] = Array.from(sizeInputs).map(input => {
        const inputElement = input as HTMLInputElement;
        const hasDisabledClass = inputElement.classList.contains('disabled');
        let available = true;
        try {
          const scriptContent = document.querySelector('variant-selects script')?.textContent || '';
          if (scriptContent) {
            const jsonData = JSON.parse(scriptContent);
            const variant = jsonData.find((v: any) => v.title.includes(inputElement.value) || v.options.includes(inputElement.value));
            if (variant) { available = variant.available; }
          }
        } catch (e) { log.error(`Error parsing variant data: ${e}`); }
        return {
          size: inputElement.value,
          is_available: !hasDisabledClass && available
        };
      });

      // Colors and Variants (extracting logic from the original evaluate block)
      const colorInputs = document.querySelectorAll('input[name="Color"]');
      const colorLabels = Array.from(colorInputs).map(input => (input as HTMLInputElement).value);
      const selectedColor = document.querySelector('input[name="Color"]:checked')?.getAttribute('value') || colorLabels[0] || '';
      const variants = colorLabels.map(color => ({ name: color, url: null }));

      // Construct the object matching ScrapedData type
      return {
        sourceUrl: window.location.href,
        product_id: productId,
        title,
        description,
        vendor,
        images, // Now correctly typed as IntermediateImage[] which matches Omit<Image, 'mushUrl'>[]
        price,
        sale_price: salePrice,
        currency,
        color: selectedColor,
        sizes,
        variants,
        // Type and Tags are not extracted in this version
        type: undefined,
        tags: [],
      };
    }); // End of page.evaluate

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

    // Construct the final Item object using the data and processed images
    const finalItem: Item = {
      ...itemData, // Spread the data from evaluate
      images: imagesWithMushUrl, // Use processed images
      status: 'ACTIVE' // Set status here or based on logic if needed
    };

    return Utils.formatItem(finalItem);

  } catch (error) {
    log.error(`Error scraping ${sourceUrl}:`, error);
    throw error;
  }
}

// Implement the Scraper interface
const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper;