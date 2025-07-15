import type { Item, Image, Size } from '../types/item.js';
import * as Utils from '../db/db-utils.js';
// import { uploadImageUrlToS3 } from '../providers/s3.js'; // Not used directly, uploadImagesToS3AndAddUrls is preferred
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../utils/logger.js';

// TODO: Update all selectors for freo.com.ua
export const SELECTORS = {
  productGrid: 'div.sc-cWSHoV.lhfkcW', // Container for all product cards
  // productLinks selector is effectively handled by the logic in getItemUrls using image srcs
  productCardImage: 'div.ant-card-cover img', // Used in getItemUrls to extract product ID
  pagination: {
    type: 'none', // All items are on one page
    // nextButton and pattern are not applicable
  },
  product: {
    container: 'div.sc-fqkvVR.kUTFjX', // Main container for product details on item page
    title: 'p.sc-kpDqfm.kQuLCr', // Product title element
    price: {
      // Selector for the main price display area container.
      // If not on sale, this element itself contains the price.
      // If on sale, this element contains two child <p> elements: one for old price, one for sale price.
      price_container: 'p.sc-dAlyuH.laLymP',
      // Selector for the old price (strikethrough), expected to be a child of price_container.
      old: 'p.sc-dAlyuH.laLymP > p[style*="text-decoration-line: line-through"]',
    },
    images: {
      container: 'div.sc-dcJsrY img', // Broadened slightly to ensure all thumbnail images are caught
      sourceUrl: 'src',
      alt: 'alt'
    },
    productId: {
      // Placeholder selector for the element containing the product ID/SKU text
      // Actual extraction logic is in scrapeItem using text content
      selector: 'div:has(> p.css-15liy7w:contains("Артикул:")) > p.css-9kt10:last-of-type',
      attribute: '' // Not using an attribute, will use textContent
    },
    description: 'div:has(> p.css-15liy7w:contains("Опис:")) > p.css-9kt10', // Description text element
    sizes: {
      container: 'div.sc-imWYAI > div > p.MuiTypography-root.css-9kt10:text-is("Оберіть розмір: *") + div > button.MuiButtonBase-root',
      label: '',
    }
  },
  // Filters are not used in this initial version based on provided HTML.
  // filters: { ... }
};

export async function getItemUrls(page: Page): Promise<Set<string>> {
  await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000 });

  const urls = await page.evaluate((imageSelector) => {
    const productImages = document.querySelectorAll(imageSelector);
    const uniqueUrls = new Set<string>();
    const baseUrl = 'https://www.freo.com.ua/shop/';

    productImages.forEach(img => {
      const src = (img as HTMLImageElement).src;
      // Example src: https://freo-server.herokuapp.com/assets/shopItems/FR-000172_1.jpg
      // Extract product ID like "FR-000172"
      const match = src.match(/FR-\d+/);
      if (match && match[0]) {
        uniqueUrls.add(baseUrl + match[0]);
      }
    });
    return [...uniqueUrls];
  }, SELECTORS.productCardImage);

  return new Set(urls);
}

export async function paginate(page: Page): Promise<boolean> {
  // All items are on the first page, so no pagination is needed.
  const log = logger.createContext('freo.com.ua');
  log.verbose('Pagination: All items are on a single page. No next page.');
  return false;
}

export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  const sourceUrl = page.url();
  try {
    await page.waitForSelector(SELECTORS.product.title, { timeout: 10000 });

    const title = await page.$eval(SELECTORS.product.title, el => el.textContent?.trim() || 'Unknown Product').catch(() => 'Unknown Product');

    const vendorCode = await page.evaluate((productIdSelector: string) => {
      const labelNode = document.evaluate('//p[normalize-space()="Артикул:"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (labelNode && labelNode.nodeType === Node.ELEMENT_NODE && (labelNode as Element).nextElementSibling) {
        return (labelNode as Element).nextElementSibling?.textContent?.trim().replace(/^FR-/, '') || '';
      }
      const el = document.querySelector(productIdSelector);
      return el?.textContent?.trim().replace(/^FR-/, '') || '';
    }, SELECTORS.product.productId.selector).catch(() => '');

    const description = await page.evaluate((descSelector: string) => {
      const labelNode = document.evaluate('//p[normalize-space()="Опис:"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (labelNode && labelNode.nodeType === Node.ELEMENT_NODE && (labelNode as Element).nextElementSibling) {
        return (labelNode as Element).nextElementSibling?.textContent?.trim() || '';
      }
      const descEl = document.querySelector(descSelector);
      return descEl?.textContent?.trim() || '';
    }, SELECTORS.product.description).catch(() => '');

    const oldPriceText = await page.$eval(SELECTORS.product.price.old, el => el.textContent?.trim()).catch(() => null);
    let currentPayablePriceText: string | null = null;

    let price = 0;
    let salePrice: number | undefined;
    let currency = 'UAH';

    const extractPriceVal = (text: string | null): number => {
      return parseFloat((text || '0').replace(/[^\d.]/g, '') || '0');
    };

    if (oldPriceText) { // Item is on sale
      price = extractPriceVal(oldPriceText); // Original price

      // Sale price is the non-strikethrough text within the price_container
      const salePriceSelectorInsideContainer = 'p:not([style*="text-decoration-line: line-through"])';
      currentPayablePriceText = await page.$eval(SELECTORS.product.price.price_container, (container, selector) => {
        const saleEl = container.querySelector(selector);
        return saleEl?.textContent?.trim() ?? null;
      }, salePriceSelectorInsideContainer).catch(() => null);

      salePrice = currentPayablePriceText ? extractPriceVal(currentPayablePriceText) : undefined;
      if (salePrice === undefined) {
        const log = logger.createContext('freo.com.ua');
        log.debug(`Item ${sourceUrl} appears on sale (old price found), but current sale price element not found within ${SELECTORS.product.price.price_container} using child selector ${salePriceSelectorInsideContainer}.`);
      }
    } else { // Item is not on sale
      currentPayablePriceText = await page.$eval(SELECTORS.product.price.price_container, el => el.textContent?.trim()).catch(() => null) || null;

      if (currentPayablePriceText) {
        const priceParts = currentPayablePriceText.split('₴').filter(Boolean);
        if (priceParts.length > 1) {
          const log = logger.createContext('freo.com.ua');
          log.debug(`Item ${sourceUrl} (not identified as sale) has multiple price parts in '${currentPayablePriceText}'. Using the last part if available, otherwise the full text.`);
          const lastPart = priceParts[priceParts.length - 1];
          price = extractPriceVal(lastPart ? '₴' + lastPart : currentPayablePriceText);
        } else {
          price = extractPriceVal(currentPayablePriceText);
        }
      } else {
        price = 0; // Default if no price text found
      }
      // salePrice remains undefined
    }

    const priceForCurrencyExtraction = currentPayablePriceText || oldPriceText;
    const currencyMatch = priceForCurrencyExtraction?.match(/[^\d.\s,]+/);
    currency = currencyMatch ? currencyMatch[0].toUpperCase() : 'UAH';

    const imagesData: { sourceUrl: string; alt_text: string }[] = await page.$$eval(SELECTORS.product.images.container, (imgs, productTitle) => {
      const collectedImages: { sourceUrl: string; alt_text: string }[] = [];
      const uniqueUrls = new Set<string>();
      imgs.forEach(img => {
        let imageUrl = img.getAttribute('src');
        if (imageUrl) {
          imageUrl = new URL(imageUrl, document.baseURI).href;
          if (!uniqueUrls.has(imageUrl)) {
            uniqueUrls.add(imageUrl);
            collectedImages.push({
              sourceUrl: imageUrl,
              alt_text: img.getAttribute('alt') || productTitle
            });
          }
        }
      });
      return collectedImages;
    }, title).catch(() => []);

    // Image handling with existing images support
    let imagesWithMushUrl: Image[];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
      const log = logger.createContext('freo.com.ua');
      log.verbose(`Using ${options.existingImages.length} existing images from database`);
      imagesWithMushUrl = options.existingImages.map(img => ({
        sourceUrl: img.sourceUrl,
        mushUrl: img.mushUrl,
        alt_text: undefined
      }));
    } else {
      if (options?.uploadToS3 !== false) {

        imagesWithMushUrl = await uploadImagesToS3AndAddUrls(imagesData, sourceUrl);

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        imagesWithMushUrl = imagesData;

      }
    }

    let sizes: Size[] = [];
    try {
      // Wait for the size buttons to be potentially available before trying to scrape them.
      await page.waitForSelector(SELECTORS.product.sizes.container, { timeout: 7000 });
      sizes = await page.$$eval(SELECTORS.product.sizes.container, (buttons) => {
        return buttons.map(btn => ({
          size: btn.textContent?.trim() || '',
          is_available: !btn.hasAttribute('disabled')
        })).filter(s => s.size);
      });
    } catch (e) {
      const log = logger.createContext('freo.com.ua');
      log.verbose(`Sizes not found or timed out for ${sourceUrl}: ${(e as Error).message}`);
      // Keep sizes as empty array if not found
    }

    const finalItem: Item = {
      sourceUrl,
      product_id: vendorCode || sourceUrl.split('/').pop()?.replace(/^FR-/, '') || '',
      title,
      description,
      images: imagesWithMushUrl,
      price,
      sale_price: salePrice,
      currency,
      sizes: sizes.length > 0 ? sizes : undefined,
      vendor: 'freo',
      status: sizes.length > 0 ? (sizes.some(s => s.is_available) ? 'ACTIVE' : 'DELETED') : 'ACTIVE',
      tags: []
    };

    return Utils.formatItem(finalItem);

  } catch (error) {
    const log = logger.createContext('freo.com.ua');
    log.error(`Error scraping item at ${sourceUrl}: ${error}`);
    throw error;
  }
}

// Ensure all required functions are exported for the Scraper type
const scraper: Scraper = {
  getItemUrls,
  paginate,
  scrapeItem
};

export default scraper; 