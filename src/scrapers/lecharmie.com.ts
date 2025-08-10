import type { Page, Browser } from 'playwright';
import type { Item, Size, Image } from '../types/item.js';
import * as Utils from "../db/db-utils.js";
import { uploadImageUrlToS3 } from '../providers/s3.js'; // Import S3 function
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js'; // Import the new helper
import type { Scraper } from './types.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('lecharmie.com');

export const SELECTORS = {
  productGrid: '.products',
  productLinks: '.product-thumbnail .woocommerce-loop-product__link',
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
 * Paginates by clicking the "Load More" button and waiting for new products to load.
 * @param page Playwright page object
 * @returns `true` if pagination likely succeeded, `false` otherwise.
 */
export async function paginate(page: Page): Promise<boolean> {
  try {
    // Wait a bit for any lazy-loaded elements
    await page.waitForTimeout(1000);
    
    // Define all possible Load More button selectors - prioritize the specific ID
    const loadMoreSelectors = [
      '#razzi-catalog-previous-ajax a',
      '.nav-previous-ajax a',
      '.ajax-loadmore a',
      '.woocommerce-navigation.ajax-loadmore a'
    ];
    
    // Try each selector until we find one that exists
    let loadMoreElement = null;
    let usedSelector = '';
    for (const selector of loadMoreSelectors) {
      const element = await page.$(selector);
      if (element) {
        loadMoreElement = element;
        usedSelector = selector;
        break;
      }
    }
    
    if (!loadMoreElement) {
      log.debug('   No Load More button found, pagination ended');
      return false;
    }

    // Get current unique product count before clicking
    const currentProductInfo = await page.evaluate((selector) => {
      const productElements = document.querySelectorAll(selector.productLinks);
      const urls = new Set();
      productElements.forEach(el => {
        const href = (el as HTMLAnchorElement).href;
        if (href && href.includes('/product/')) {
          urls.add(href);
        }
      });
      return {
        count: productElements.length,
        uniqueUrls: urls.size
      };
    }, SELECTORS);

    log.debug(`   Current products: count=${currentProductInfo.count}, unique=${currentProductInfo.uniqueUrls}`);
    log.debug(`   Found Load More button with selector: ${usedSelector}`);

    // Check if button is visible and get its text
    const buttonInfo = await page.evaluate((selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        isVisible: rect.width > 0 && rect.height > 0,
        text: element.textContent?.trim(),
        href: (element as HTMLAnchorElement).href
      };
    }, usedSelector);

    if (!buttonInfo || !buttonInfo.isVisible) {
      log.debug('   Load More button not visible, pagination ended');
      return false;
    }

    log.debug(`   Clicking Load More button: "${buttonInfo.text}" (${buttonInfo.href})`);

    // Store the current URL to check if navigation happens
    const urlBefore = page.url();

    // Scroll the page down first to ensure button is in viewport
    await page.evaluate(() => {
      window.scrollBy(0, 300);
    });
    await page.waitForTimeout(500);

    // Click and wait for the response/DOM change
    const responsePromise = page.waitForResponse(
      response => response.url().includes('/katalog/page/') && response.status() === 200,
      { timeout: 10000 }
    ).catch(() => null);
    
    // Click using direct element click with force option
    await page.click(usedSelector, { force: true });
    
    // Wait for the AJAX response
    const response = await responsePromise;
    if (response) {
      log.debug(`   Got AJAX response from: ${response.url()}`);
    }
    
    // Check if URL changed (indicating navigation vs AJAX)
    const urlAfter = page.url();
    if (urlBefore !== urlAfter) {
      log.debug(`   URL changed from ${urlBefore} to ${urlAfter} - appears to be navigation`);
      // Wait for navigation to complete
      await page.waitForLoadState('domcontentloaded');
    }
    
    // Wait for DOM to update after AJAX completes
    await page.waitForTimeout(3000);
    
    // Alternative: Wait for DOM mutation or new elements
    try {
      await page.waitForFunction(
        (oldCount, selector) => {
          const productElements = document.querySelectorAll(selector.productLinks);
          const urls = new Set();
          productElements.forEach(el => {
            const href = (el as HTMLAnchorElement).href;
            if (href && href.includes('/product/')) {
              urls.add(href);
            }
          });
          return urls.size > oldCount;
        },
        { timeout: 5000 },
        currentProductInfo.uniqueUrls,
        SELECTORS
      );
      log.debug('   Detected new products via DOM mutation');
    } catch {
      log.debug('   No DOM mutation detected for new products');
    }

    // Check if new products were loaded with detailed debugging
    const productInfo = await page.evaluate((selector) => {
      const productElements = document.querySelectorAll(selector.productLinks);
      const productContainer = document.querySelector(selector.productGrid);
      
      // Get unique product URLs
      const urls = new Set();
      productElements.forEach(el => {
        const href = (el as HTMLAnchorElement).href;
        if (href && href.includes('/product/')) {
          urls.add(href);
        }
      });
      
      return {
        count: productElements.length,
        uniqueUrls: urls.size,
        containerFound: !!productContainer,
        containerChildren: productContainer ? productContainer.children.length : 0,
        sampleUrls: Array.from(urls).slice(0, 3)
      };
    }, SELECTORS);

    log.debug(`   Product info after click: count=${productInfo.count}, unique=${productInfo.uniqueUrls}, container=${productInfo.containerFound}, children=${productInfo.containerChildren}`);
    if (productInfo.sampleUrls.length > 0) {
      log.debug(`   Sample URLs: ${productInfo.sampleUrls.join(', ')}`);
    }

    // Check if we have products and they're different (either more products or different URLs)
    if (productInfo.uniqueUrls > currentProductInfo.uniqueUrls) {
      log.debug(`   Pagination successful, new unique product count: ${productInfo.uniqueUrls}`);
      // Wait a bit for DOM to stabilize
      await page.waitForTimeout(1000);
      return true;
    } else if (productInfo.uniqueUrls > 0 && response) {
      // If we got a successful response and still have products, check if button still exists
      // This handles cases where content is replaced rather than appended
      const buttonStillExists = await page.$(usedSelector);
      if (buttonStillExists) {
        // Check if button text or href changed (indicating next page)
        const newButtonInfo = await page.evaluate((selector) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          return {
            text: element.textContent?.trim(),
            href: (element as HTMLAnchorElement).href
          };
        }, usedSelector);
        
        if (newButtonInfo && newButtonInfo.href !== buttonInfo.href) {
          log.debug(`   Products replaced, button now points to: ${newButtonInfo.href}`);
          return true;
        }
      }
      log.debug(`   No new products and button unchanged, pagination likely ended`);
      return false;
    } else {
      log.debug(`   No new products loaded (still ${productInfo.uniqueUrls} unique), pagination likely ended`);
      return false;
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.debug(`   Pagination error: ${errorMessage}`);
    return false;
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
}): Promise<Item[]> {
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

    return [Utils.formatItem(item)];

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