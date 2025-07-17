import type { Page } from 'playwright';
import type { Item, Image, Size } from '../types/item.js';
import type { Scraper } from './types.js';
import * as Utils from '../db/db-utils.js';
// import { getSiteConfig, extractDomain } from '../diagnostics/site-utils.js'; // No longer needed
import { uploadImageUrlToS3 } from '../providers/s3.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('lowposh.com');

/**
 * This file follows the page-pagination template.
 */

export const SELECTORS = {
  // Product listing page selectors
  productGrid: 'product-grid-item', // Custom element for product grid items
  productLinks: 'product-grid-item-content a[href*="/products/"]', // Links inside product grid item content
  pagination: {
    type: 'none' as const,  // Site has no pagination - all products on one page
    pattern: ''
  },
  // Individual product page selectors
  product: {
    title: 'h1.product__title',
    price: '[data-product-price]',
    images: 'img[data-product-image]',
    // Size selectors
    sizesWrapper: '.selector-wrapper--fullwidth',
    sizeInputs: 'input[name="options[Size]"]',
    sizeLabels: 'label[for^="template--"]',
    // Product data
    productDataScript: 'script[data-product-json]',
    // Description selectors
    description: '.product-single__description'
  }
};

/**
 * Gathers item URLs on the current page
 * @param page Playwright page object
 * @returns A set of product URLs
 */
export async function getItemUrls(page: Page): Promise<Set<string>> {
  log.debug('Getting item URLs from page:', page.url());

  // Wait for the product grid to load
  await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000 })
    .catch(err => log.debug('Warning: Product grid not found, continuing anyway'));

  // Wait for product links with a longer timeout
  await page.waitForSelector(SELECTORS.productLinks, { timeout: 10000 });

  // Get all product links
  const links = await page.$$eval(SELECTORS.productLinks, els =>
    els.map(e => (e as HTMLAnchorElement).href)
  );

  log.debug(`Found ${links.length} product links on page`);
  return new Set(links);
}

/**
 * Paginates - for lowposh.com this always returns false as all products load on one page
 * @param page Playwright page object
 * @returns boolean - always false for this site
 */
export async function paginate(page: Page): Promise<boolean> {
  log.debug('No pagination needed for lowposh.com - all products on single page');
  return false;
}

/**
 * Scrapes item details from the provided URL
 * @param url The URL of the product to scrape
 * @returns A formatted Item object
 */
export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  const sourceUrl = page.url();
  log.debug(`Scraping item: ${sourceUrl}`);

  try {
    // Page is already at the correct URL. Ensure content is loaded.
    // Check for 404 page content before waiting for product selectors
    const is404 = await page.evaluate(() => {
      const h1 = document.querySelector('h1.title');
      return h1 && h1.textContent?.includes('404 Сторінка не знайдена');
    });

    if (is404) {
      throw new Error('Page not found (404)'); // Throw specific error for 404
    }

    // Wait for page to fully load
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000); // Give JS time to render
    
    // Debug: log current URL and check if page loaded
    log.debug('Current URL:', page.url());
    
    // Try to wait for any h1 element first as a basic check
    try {
      await page.waitForSelector('h1', { timeout: 5000 });
    } catch (e) {
      log.error('No h1 element found on page');
      const pageContent = await page.content();
      log.debug('Page content preview:', pageContent.substring(0, 500));
    }
    
    // Wait for critical elements
    await page.waitForSelector(SELECTORS.product.title, { timeout: 15000 });
    await page.waitForSelector(SELECTORS.product.price, { timeout: 15000 });

    // Extract product data from JSON script
    const productJson = await page.$eval(SELECTORS.product.productDataScript, el => {
      return JSON.parse(el.textContent || '{}');
    }).catch(() => {
      log.debug('Product JSON not found, will use DOM scraping');
      return null;
    });

    // Extract title
    const title = await page.$eval(SELECTORS.product.title, el => el.textContent?.trim() || '');

    // Extract price
    const priceText = await page.$eval(SELECTORS.product.price, el => el.textContent?.trim() || '');
    const price = parseFloat(priceText.replace(/[^\d.,]/g, '').replace(/,/g, ''));
    const currency = 'UAH';

    // Extract images from DOM using data-bgset for high-res URLs
    let images: Image[] = await page.$$eval(SELECTORS.product.images, (els, pageTitle) => {
      const uniqueUrls = new Set<string>();
      return els
        .map(el => {
          const img = el as HTMLImageElement;
          // Try to get high-res URL from data-bgset
          const bgset = img.getAttribute('data-bgset');
          let sourceUrl = '';
          
          if (bgset) {
            // Parse bgset to get the highest resolution URL
            const matches = bgset.match(/https:\/\/[^\s]+\.jpg\?v=\d+/g);
            if (matches && matches.length > 0) {
              // Get the last URL which is typically the highest resolution
              sourceUrl = matches[matches.length - 1];
            }
          }
          
          // Fallback to src if no bgset
          if (!sourceUrl) {
            sourceUrl = img.src;
          }
          
          // Replace _1x.jpg with higher resolution if it exists
          if (sourceUrl.includes('_1x.jpg')) {
            sourceUrl = sourceUrl.replace('_1x.jpg', '_1800x.jpg');
          }
          
          // Skip if duplicate or placeholder
          if (!sourceUrl || uniqueUrls.has(sourceUrl) || sourceUrl.includes('1x1.jpg')) {
            return null;
          }
          
          uniqueUrls.add(sourceUrl);
          return {
            sourceUrl,
            alt_text: img.alt || pageTitle || undefined
          };
        })
        .filter(img => img !== null);
    }, title);

    // Extract sizes from DOM
    let formattedSizes: Size[] = [];
    
    try {
      // Get all size inputs and their corresponding labels
      const sizeData = await page.evaluate((selectors) => {
        const inputs = document.querySelectorAll(selectors.sizeInputs);
        const sizes: Array<{ size: string; is_available: boolean }> = [];
        
        inputs.forEach(input => {
          const inputEl = input as HTMLInputElement;
          const labelEl = document.querySelector(`label[for="${inputEl.id}"]`);
          if (labelEl) {
            const sizeText = labelEl.textContent?.trim() || inputEl.value;
            // Check if input is disabled to determine availability
            const isAvailable = !inputEl.disabled;
            sizes.push({
              size: sizeText,
              is_available: isAvailable
            });
          }
        });
        
        return sizes;
      }, { sizeInputs: SELECTORS.product.sizeInputs, sizeLabels: SELECTORS.product.sizeLabels });
      
      formattedSizes = sizeData;
    } catch (error) {
      log.error('Size extraction failed:', error);
    }
    
    // If JSON is available, use it to check availability
    if (productJson?.variants && Array.isArray(productJson.variants) && formattedSizes.length > 0) {
      formattedSizes = formattedSizes.map(size => {
        const variant = productJson.variants.find((v: any) => 
          v.option1 === size.size || v.option2 === size.size || v.option3 === size.size
        );
        return {
          size: size.size,
          is_available: variant ? variant.available : size.is_available
        };
      });
    }


    // Extract description
    let description = await page.$eval(SELECTORS.product.description, el => 
      el.textContent?.trim() || ''
    ).catch(() => '');
    
    // Clean up description from JSON if available
    if (!description && productJson?.body_html) {
      description = productJson.body_html
        .replace(/<\/?[^>]+(>|$)/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Extract product ID from URL
    const product_id = sourceUrl.split('/').pop()?.split('?')[0] || '';

    // Extract color from title (after | separator)
    let color: string | undefined = undefined;
    if (title.includes('|')) {
      const titleParts = title.split('|');
      if (titleParts.length > 1) {
        color = titleParts[titleParts.length - 1].trim();
      }
    }


    const itemData: Omit<Item, 'mushUrl' | 'status'> = {
      sourceUrl,
      product_id,
      title,
      images,
      price,
      currency,
      description,
      sizes: formattedSizes,
      color,
      // No sale price on this product
      sale_price: undefined,
      variants: undefined
    };

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

        imagesWithMushUrl = await uploadImagesToS3AndAddUrls(itemData.images, itemData.sourceUrl);

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        imagesWithMushUrl = itemData.images;

      }
    }
    // --- End S3 Upload Logic ---

    // Construct the final Item object using the updated images array
    const finalItem: Item = {
      ...itemData,
      images: imagesWithMushUrl, // Use processed images
      status: 'ACTIVE'
    };

    return Utils.formatItem(finalItem);
  } finally {
    // await browser.close(); // Browser lifecycle managed by the caller
  }
}

// Create the scraper object and export it as default
const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper;