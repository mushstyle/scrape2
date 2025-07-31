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
    infoContainer: '.wt-product__main',
    title: 'h1.wt-product__name', 
    priceContainer: '.wt-product__price',
    price: '.price__regular .price-item--regular',
    salePrice: '.price__sale .price-item--sale',
    comparePrice: '.price__sale s.price-item--regular',
    images: 'gallery-section img.wt-product__img',
    description: '.wt-collapse__target--text',
    vendor: '.wt-product__brand__name',
    productId: 'input[name="product-id"]',
    variantDataScript: 'variant-options script[type="application/json"]',
    sizeInputs: 'input[name="Size"], input[name="SIZE"]',
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
}): Promise<Item[]> {
  const sourceUrl = page.url();
  try {
    // Wait for product info to load
    await page.waitForSelector('.wt-product__main', { timeout: 10000 });
    
    // Try to expand the description section if it exists
    try {
      const triggers = await page.$$('.wt-collapse__trigger');
      for (const trigger of triggers) {
        const titleText = await trigger.$eval('.wt-collapse__trigger__title', el => el.textContent?.trim());
        if (titleText === 'Опис') {
          await trigger.click();
          await page.waitForTimeout(500); // Wait for expansion animation
          break;
        }
      }
    } catch (e) {
      // Ignore if can't expand
    }

    // Extract product details from the page
    // Define an intermediate type for clarity before S3 processing
    type ScrapedData = Omit<Item, 'images' | 'status'> & {
      images: Omit<Image, 'mushUrl'>[]; // Images before S3 upload
    };

    const itemData: ScrapedData = await page.evaluate(() => {
      // Product ID - extract from input field
      const productId = document.querySelector('input[name="product-id"]')?.getAttribute('value') || '';

      // Title
      const title = document.querySelector('h1.wt-product__name')?.textContent?.trim() || '';

      // Price and Sale Price handling
      let price = 0;
      let salePrice: number | undefined = undefined;
      
      // Check if product is on sale
      const priceContainer = document.querySelector('.price');
      const hasOnSale = priceContainer?.classList.contains('price--on-sale');
      
      if (hasOnSale) {
        // Product is on sale - get original price from strikethrough
        const comparePriceElement = document.querySelector('.price__sale s.price-item--regular');
        if (comparePriceElement) {
          const comparePriceText = comparePriceElement.textContent?.trim() || '';
          const priceMatch = comparePriceText.match(/₴([\d,]+(\.\d+)?)/);
          if (priceMatch) {
            price = Number(priceMatch[1].replace(/,/g, ''));
          }
        }
        
        // Get sale price
        const salePriceElement = document.querySelector('.price__sale .price-item--sale');
        if (salePriceElement) {
          const salePriceText = salePriceElement.textContent?.trim() || '';
          const salePriceMatch = salePriceText.match(/₴([\d,]+(\.\d+)?)/);
          if (salePriceMatch) {
            salePrice = Number(salePriceMatch[1].replace(/,/g, ''));
          }
        }
      } else {
        // Product is not on sale - get regular price only
        const priceElement = document.querySelector('.price__regular .price-item--regular');
        if (priceElement) {
          const priceText = priceElement.textContent?.trim() || '';
          const priceMatch = priceText.match(/₴([\d,]+(\.\d+)?)/);
          if (priceMatch) {
            price = Number(priceMatch[1].replace(/,/g, ''));
          }
        }
      }
      
      const currency = 'UAH';

      // Description - get from collapsible section with "Опис" title or from the target content
      let description = '';
      const collapseElements = document.querySelectorAll('.wt-collapse');
      for (const collapse of collapseElements) {
        const titleElement = collapse.querySelector('.wt-collapse__trigger__title');
        if (titleElement?.textContent?.trim() === 'Опис') {
          // Try different selectors for description content
          const descContent = collapse.querySelector('.wt-collapse__target--text .rte') || 
                             collapse.querySelector('.wt-collapse__target .rte') ||
                             collapse.querySelector('.wt-collapse__target--text');
          if (descContent) {
            description = descContent.textContent?.trim() || '';
            break;
          }
        }
      }

      // Vendor - get from meta tag or brand name
      const vendor = document.querySelector('meta[itemprop="brand"]')?.getAttribute('content') || 
                    document.querySelector('.wt-product__brand__name')?.textContent?.trim() || '';

      // Images - get from gallery section
      const imageElements = document.querySelectorAll('gallery-section img.wt-product__img');
      const uniqueImageUrls = new Set<string>();
      type IntermediateImage = { sourceUrl: string; alt_text: string };

      const images: IntermediateImage[] = Array.from(imageElements)
        .map(img => {
          const imgElement = img as HTMLImageElement;
          // Get the src without query parameters
          let url = imgElement.src;
          
          // Handle protocol-relative URLs
          if (url.startsWith('//')) {
            url = 'https:' + url;
          }
          
          // Remove query parameters to get the base image URL
          url = url.split('?')[0];
          
          if (url && !uniqueImageUrls.has(url)) {
            uniqueImageUrls.add(url);
            return {
              sourceUrl: url,
              alt_text: imgElement.alt || title || ''
            };
          }
          return null;
        })
        .filter((img): img is IntermediateImage => img !== null);

      // Sizes - get from variant options (handle both "Size" and "SIZE" input names)
      const sizeInputs = document.querySelectorAll('input[name="Size"], input[name="SIZE"]');
      const sizes: Size[] = [];
      
      // Get variant data to check availability
      let variantData: any[] = [];
      try {
        const scriptContent = document.querySelector('variant-options script[type="application/json"]')?.textContent || '';
        if (scriptContent) {
          variantData = JSON.parse(scriptContent);
        }
      } catch (e) {
        console.error('Error parsing variant data:', e);
      }
      
      // Process size inputs
      Array.from(sizeInputs).forEach(input => {
        const inputElement = input as HTMLInputElement;
        const sizeValue = inputElement.value;
        
        // Find corresponding variant data
        const variant = variantData.find(v => 
          v.title === sizeValue || 
          v.option1 === sizeValue || 
          v.options?.includes(sizeValue)
        );
        
        sizes.push({
          size: sizeValue,
          is_available: variant ? variant.available : true
        });
      });

      // Colors and Variants
      const colorInputs = document.querySelectorAll('input[name="Color"]');
      const colorLabels = Array.from(colorInputs).map(input => (input as HTMLInputElement).value);
      const selectedColor = document.querySelector('input[name="Color"]:checked')?.getAttribute('value') || colorLabels[0] || '';
      const variants = colorLabels.map(color => ({ name: color, url: null }));

      // Construct the object
      return {
        sourceUrl: window.location.href,
        product_id: productId,
        title,
        description,
        vendor,
        images,
        price,
        sale_price: salePrice,
        currency,
        color: selectedColor,
        sizes,
        variants,
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

    return [Utils.formatItem(finalItem)];

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