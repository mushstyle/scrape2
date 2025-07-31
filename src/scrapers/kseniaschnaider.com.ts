import type { Page } from 'playwright';
import type { Item, Image, Size } from '../types/item.js';
import * as Utils from "../db/db-utils.js";
import type { Scraper } from './types.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('kseniaschnaider.com');

/**
 * Scraper for kseniaschnaider.com that uses infinite scroll pagination
 */

export const SELECTORS = {
  productGrid: 'body', // Using body as a safe general selector
  productLinks: 'a[href^="/products/"]', // Specific selector for product links
  product: {
    title: 'h1',
    price: '.price',
    images: 'media-gallery picture img',
    description: '.description .text.rte',
    sizes: '.product-form__input--pill input[type="radio"]',
    variants: '.variants a'
  }
};

const ITEM_SELECTOR = 'x-cell'; // Selector for individual product items loaded by scroll

/**
 * Gathers item URLs from the current page using specific link pattern.
 * @param page Playwright page object
 * @returns Set of product URLs
 */
export async function getItemUrls(page: Page): Promise<Set<string>> {
  // Using the direct DOM approach to avoid selector waiting issues
  try {
    const urls = await page.evaluate((selector) => {
      const links = Array.from(document.querySelectorAll(selector));

      return links.map(link => {
        const href = link.getAttribute('href');
        return href?.startsWith('http') ? href : window.location.origin + href;
      }).filter((url): url is string => url !== null && url !== undefined);
    }, SELECTORS.productLinks); // Pass selector to evaluate

    return new Set(urls);
  } catch (error) {
    log.debug(`Could not evaluate product links (${SELECTORS.productLinks}) on ${page.url()}, returning empty set. Error: ${error}`);
    return new Set<string>();
  }
}

/**
 * Scrolls down to load more products and checks if new items were loaded.
 * Retries scrolling once if the item count doesn't initially increase.
 * @param page Playwright page object
 * @returns `true` if new items were likely loaded, `false` otherwise.
 */
export async function paginate(page: Page): Promise<boolean> {
  try {
    log.debug('   Checking item count before scroll...');
    const initialItemCount = await page.$$eval(ITEM_SELECTOR, els => els.length).catch(() => 0);
    log.debug(`      Initial item count: ${initialItemCount}`);

    log.debug('   Scrolling down (Attempt 1)...');
    await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
    await page.waitForTimeout(3000); // Wait for potential load

    let newItemCount = await page.$$eval(ITEM_SELECTOR, els => els.length).catch(() => initialItemCount);
    log.debug(`      Item count after scroll 1: ${newItemCount}`);

    if (newItemCount > initialItemCount) {
      log.debug('   New items loaded after first scroll.');
      return true;
    } else {
      // Item count didn't increase, try scrolling one more time
      log.debug('   Item count did not increase. Scrolling again (Attempt 2)...');
      await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
      await page.waitForTimeout(3500); // Slightly longer wait for the second attempt

      const finalItemCount = await page.$$eval(ITEM_SELECTOR, els => els.length).catch(() => initialItemCount);
      log.debug(`      Item count after scroll 2: ${finalItemCount}`);

      if (finalItemCount > initialItemCount) {
        log.debug('   New items loaded after second scroll.');
        return true;
      } else {
        log.debug('   No new items loaded after second scroll, assuming end of pagination.');
        return false;
      }
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('Target page, context or browser has been closed')) {
      log.debug(`   Pagination stopped: ${errorMessage}`);
      return false;
    }
    log.error(`   Error during scroll pagination: ${errorMessage}`);
    return false; // Indicate pagination failed or ended due to error
  }
}

/**
 * Scrapes item details from the provided URL
 * @param url The product URL
 * @returns A structured Item object
 */
export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item[]> {
  const sourceUrl = page.url();
  try {
    // Page is already at sourceUrl, ensure content is loaded.
    // await page.goto(sourceUrl, { waitUntil: 'domcontentloaded' }); // Already on page

    // Define an intermediate type based on the evaluate function's return
    type ScrapedData = {
      sourceUrl: string;
      product_id: string;
      title: string;
      description: string;
      vendor: string;
      type: string;
      images: Omit<Image, 'mushUrl'>[]; // Images before S3 processing
      price: number;
      sale_price: number | undefined;
      currency: string;
      sizes: Size[];
      variants: { name: string; url: string | null }[];
      status: 'ACTIVE' | 'DELETED';
    };

    const itemData: ScrapedData = await page.evaluate((SELECTORS) => {
      // --- Start of evaluate logic ---
      const title = document.querySelector(SELECTORS.product.title)?.textContent?.trim() || '';
      const productSection = document.querySelector('section.product-page');
      let product_id = productSection?.getAttribute('data-product-id') || '';
      let price = 0;
      let sale_price: number | undefined;
      let status: 'ACTIVE' | 'DELETED' = 'ACTIVE';
      const priceElement = document.querySelector(SELECTORS.product.price);
      if (priceElement) {
        const isOnSale = priceElement.classList.contains('on-sale');
        if (isOnSale) {
          const regularPriceEl = priceElement.querySelector('s.price-item--regular');
          const regularPriceText = regularPriceEl?.textContent?.trim() || '';
          price = parseFloat(regularPriceText.replace(/[^0-9.]/g, '')) || 0;
          const salePriceEl = priceElement.querySelector('.price-item--sale');
          const salePriceText = salePriceEl?.textContent?.trim() || '';
          sale_price = parseFloat(salePriceText.replace(/[^0-9.]/g, '')) || 0;
        } else {
          const regularPriceEl = priceElement.querySelector('.price-item--regular');
          const regularPriceText = regularPriceEl?.textContent?.trim() || '';
          price = parseFloat(regularPriceText.replace(/[^0-9.]/g, '')) || 0;
        }
      }
      if (price === 0) { status = 'DELETED'; }
      let currency = 'USD';
      const priceText = priceElement?.textContent || '';
      if (priceText.includes('$')) { currency = 'USD'; }
      const imagesRaw = Array.from(document.querySelectorAll(SELECTORS.product.images))
        .map(img => {
          const imgEl = img as HTMLImageElement;
          const srcset = imgEl.getAttribute('srcset');
          let highestResSrc = '';
          if (srcset) {
            const srcsetParts = srcset.split(',').map(s => s.trim());
            const lastSrc = srcsetParts[srcsetParts.length - 1];
            highestResSrc = lastSrc.split(' ')[0];
          }
          return {
            sourceUrl: highestResSrc || imgEl.src,
            alt_text: imgEl.alt || ''
          };
        })
        .filter(img => img.sourceUrl && !img.sourceUrl.startsWith('data:') && !img.sourceUrl.includes('blank.gif'));
      const images = imagesRaw.map(img => {
        if (img.sourceUrl.startsWith('//')) {
          return { ...img, sourceUrl: 'https:' + img.sourceUrl };
        }
        return img;
      });
      const descriptionEl = document.querySelector(SELECTORS.product.description);
      const description = descriptionEl?.textContent?.trim() || '';
      const sizeInputs = Array.from(document.querySelectorAll(SELECTORS.product.sizes));
      const sizes = sizeInputs.map(input => {
        const inputEl = input as HTMLInputElement;
        const labelEl = inputEl.nextElementSibling;
        let sizeLabel = '';
        if (labelEl) {
          const textNodes = Array.from(labelEl.childNodes).filter(node => node.nodeType === Node.TEXT_NODE);
          if (textNodes.length > 0) {
            sizeLabel = textNodes[0].textContent?.trim() || '';
          } else {
            sizeLabel = labelEl.firstChild?.textContent?.trim() || '';
          }
        }
        const isAvailable = !inputEl.classList.contains('disabled');
        return { size: sizeLabel, is_available: isAvailable };
      });
      const variantLinks = Array.from(document.querySelectorAll(SELECTORS.product.variants));
      const variants = variantLinks.map(link => {
        const linkEl = link as HTMLAnchorElement;
        const classList = Array.from(linkEl.classList);
        const colorClass = classList.find(c => c !== 'color' && c !== 'selected');
        const colorName = colorClass || '';
        return { name: colorName, url: linkEl.href || null };
      }).filter(v => v.name);
      const vendor = 'Ksenia Schnaider';
      let type = '';
      if (description.toLowerCase().includes('t-shirt')) {
        type = 'T-Shirt';
      }

      return {
        sourceUrl: window.location.href,
        product_id,
        title,
        description,
        vendor,
        type,
        images,
        price,
        sale_price,
        currency,
        sizes,
        variants,
        status
      };
      // --- End of evaluate logic ---
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

    // Construct the final Item object
    const finalItem: Item = {
      sourceUrl: itemData.sourceUrl,
      product_id: itemData.product_id,
      title: itemData.title,
      description: itemData.description,
      vendor: itemData.vendor,
      type: itemData.type,
      images: imagesWithMushUrl, // Use processed images
      price: itemData.price,
      sale_price: itemData.sale_price,
      currency: itemData.currency,
      sizes: itemData.sizes,
      variants: itemData.variants,
      status: itemData.status,
      tags: [], // Add tags property
      // mushUrl at top level is handled by formatItem
    };

    // Format and return
    return [Utils.formatItem(finalItem)];

  } finally {
    // await browser.close(); // Browser lifecycle managed by the caller
  }
}

// Define the default export for the scraper
const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper;