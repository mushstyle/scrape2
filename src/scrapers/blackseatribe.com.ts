import { Page } from 'playwright';
import { Item, Size } from '../db/types.js';
import * as Utils from '../db/db-utils.js';
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../lib/logger.js';

const log = logger.createContext('blackseatribe.com');

export const SELECTORS = {
  productGrid: 'div.catalog-category__list',
  productLinks: 'div.catalog-category__list-item > a', // The <a> tag directly under the item container
  // Load more button - not applicable as per user, all items on one page
  product: {
    container: 'section#product-product div.catalog-product__product',
    title: 'div.catalog-product__product-info-title > h1',
    price: {
      price_container: 'div.catalog-product__product-info-price',
      original_price_on_sale_page: 'span.catalog-product__product-info-price-special span.autocalc-product-price',
      current_display_price: 'span.autocalc-product-special', // This should be the actual sale price if present
      // Fallback for regular price when not explicitly a sale page structure
      regular_price_not_on_sale: 'span:not(.catalog-product__product-info-price-special) span.autocalc-product-price'
    },
    images: {
      // Images are within div.catalog-product__product-images-image > img
      // The first one often has an <a> tag parent for fancybox
      container: 'div.catalog-product__product-images-image img',
      sourceUrl: 'src', // 'src' attribute of the img
      alt: 'alt'  // 'alt' attribute of the img
    },
    productId: {
      // Product ID seems to be in a hidden input with name="product_id"
      selector: 'input[name="product_id"]',
      attribute: 'value'
    },
    description: 'div.custom-information__item:has(div.custom-information__opener:contains("Опис")) div.catalog-product__product-info-description',
    sizes: {
      // Sizes are radio buttons within labelled divs
      // There are two groups: "Розмір верху" and "Розмір низу"
      // We will try to get all of them.
      // Selector for each size option container (e.g., div.custom-size with id opty_22)
      // Then inside, label.custom-size__item contains input and span.custom-size__text
      sizeGroupContainer: 'div.custom-size', // Targets both size groups
      sizeNameHeader: 'div.custom-size__name', // To get "Розмір верху" or "Розмір низу"
      options: 'label.custom-size__item', // Each size option (XS, S, M, L)
      label: 'span.custom-size__text',   // The text of the size (e.g., "XS")
      // Availability: The radio buttons are not disabled by default in the example.
      // We'll assume they are available unless specific classes/attributes indicate otherwise.
      // This might need adjustment if "sold out" sizes are marked differently.
    }
  }
};

export async function getItemUrls(page: Page): Promise<Set<string>> {
  await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000 });

  const urls = await page.evaluate((productLinkSelector) => {
    const productLinks = document.querySelectorAll(productLinkSelector);
    const uniqueUrls = new Set<string>();
    // Using document.baseURI which is more robust than assuming window.location.origin or trying to find a <base> tag
    const base = document.baseURI;

    productLinks.forEach(link => {
      const href = (link as HTMLAnchorElement).href;
      if (href) {
        try {
          uniqueUrls.add(new URL(href, base).href);
        } catch (e) {
          log.error(`Invalid URL found on page: ${href}. Error: ${(e as Error).message}`);
        }
      }
    });
    return [...uniqueUrls];
  }, SELECTORS.productLinks);

  return new Set(urls);
}

// As per user: all products load there, no need to click to other pages
export async function paginate(page: Page): Promise<boolean> {
  log.debug('   Pagination: Site loads all items on one page. No pagination action needed.');
  return false;
}

// Helper function to parse price string (e.g., "7500грн")
const parsePrice = (priceText: string | null): { amount: number; currency: string } | null => {
  if (!priceText) return null;
  const cleanedText = priceText.replace(/\s+/g, '').trim(); // Remove spaces

  const amountMatch = cleanedText.match(/[\d,.]+/);
  const currencyMatch = cleanedText.match(/[^\d,.]+/); // Match non-digits/commas/periods as currency

  if (!amountMatch || !amountMatch[0]) return null;

  const amount = parseFloat(amountMatch[0].replace(',', '.'));
  let currency = 'UAH'; // Default currency

  if (currencyMatch && currencyMatch[0]) {
    const symbol = currencyMatch[0].toUpperCase();
    if (symbol === 'ГРН' || symbol === 'UAH') currency = 'UAH';
    else if (symbol === '$' || symbol === 'USD') currency = 'USD';
    else if (symbol === '€' || symbol === 'EUR') currency = 'EUR';
    // Add other common currency symbols if needed
  }

  if (isNaN(amount)) return null;
  return { amount, currency };
};

export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  const sourceUrl = page.url();
  log.debug(`   Scraping item: ${sourceUrl}`);

  // --- POPUP HANDLING START ---
  const popupSelector = 'div.popup-reg.open';
  const popupCloseButtonSelector1 = 'div.popup-reg__close';
  const popupCloseButtonSelector2 = 'div.popup-reg__cont'; // "Ні, дякую"

  try {
    // Wait for a short period to see if popup appears
    await page.waitForSelector(popupSelector, { timeout: 5000 });
    log.debug(`   Popup detected: ${popupSelector}`);

    const closeButton1 = await page.$(popupCloseButtonSelector1);
    if (closeButton1 && await closeButton1.isVisible()) {
      log.debug(`   Attempting to close popup with selector: ${popupCloseButtonSelector1}`);
      await closeButton1.click({ timeout: 2000 });
      await page.waitForTimeout(500); // Wait for popup to disappear
    } else {
      const closeButton2 = await page.$(popupCloseButtonSelector2);
      if (closeButton2 && await closeButton2.isVisible()) {
        log.debug(`   Attempting to close popup with selector: ${popupCloseButtonSelector2}`);
        await closeButton2.click({ timeout: 2000 });
        await page.waitForTimeout(500); // Wait for popup to disappear
      }
    }
    // Check if popup is still there
    if (await page.isVisible(popupSelector)) {
      log.error(`   Popup still visible after attempting to close. Trying Escape key.`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      if (await page.isVisible(popupSelector)) {
        log.error(`   Popup persists even after Escape key. Proceeding, but scraping might fail.`);
      } else {
        log.debug('   Popup closed with Escape key.');
      }
    } else {
      log.debug('   Popup closed successfully.');
    }
  } catch (e) {
    // If popup doesn't appear within timeout, that's fine, just means no popup to close.
    if ((e as Error).name === 'TimeoutError') {
      log.debug('   No registration popup detected within timeout, proceeding.');
    } else {
      log.error(`   Error during popup handling for ${sourceUrl}: ${(e as Error).message}`);
    }
  }
  // --- POPUP HANDLING END ---

  try {
    await page.waitForSelector(SELECTORS.product.container, { timeout: 10000 });

    const title = await page.$eval(SELECTORS.product.title, el => el.textContent?.trim() || 'Unknown Product').catch(() => 'Unknown Product');

    let vendorCode = '';
    try {
      vendorCode = await page.$eval(SELECTORS.product.productId.selector, (el) => (el as HTMLInputElement).value, SELECTORS.product.productId.attribute) || '';
    } catch (e) {
      log.error(`   Could not find product_id for ${sourceUrl}: ${(e as Error).message}`);
      // Fallback if product_id input is not found
      const urlParts = sourceUrl.split('/');
      vendorCode = urlParts.pop() || urlParts.pop() || Date.now().toString(); // Use last or second to last part of URL or timestamp
    }

    const descriptionHTML = await page.$eval(SELECTORS.product.description, el => el.innerHTML.trim() || '').catch(() => '');

    // Price scraping
    let price = 0; // This will store the ORIGINAL price
    let salePrice: number | undefined; // This will store the SALE price
    let currency = 'UAH';

    try {
      const priceContainer = await page.$(SELECTORS.product.price.price_container);
      if (priceContainer) {
        const originalPriceText = await priceContainer.$eval(SELECTORS.product.price.original_price_on_sale_page, el => el.getAttribute('data-value') || el.textContent?.trim() || null).catch(() => null);
        const currentDisplayPriceText = await priceContainer.$eval(SELECTORS.product.price.current_display_price, el => el.getAttribute('data-value') || el.textContent?.trim() || null).catch(() => null);

        const parsedOriginal = parsePrice(originalPriceText);
        const parsedCurrentDisplay = parsePrice(currentDisplayPriceText);

        if (parsedOriginal && parsedCurrentDisplay) {
          // Both original (e.g., 1600) and current display (e.g., 1280, which is the sale price) are found
          price = parsedOriginal.amount;
          currency = parsedOriginal.currency;
          if (parsedCurrentDisplay.amount < parsedOriginal.amount) {
            salePrice = parsedCurrentDisplay.amount;
            if (parsedCurrentDisplay.currency !== currency) {
              log.error(`   Currency mismatch on sale item: Original ${currency}, Sale ${parsedCurrentDisplay.currency} for ${sourceUrl}. Using original currency.`);
            }
          } else {
            log.error(`   Original price ${parsedOriginal.amount} found, but current display price ${parsedCurrentDisplay.amount} is not lower. Assuming not a sale or misidentified sale structure. Source: ${sourceUrl}`);
          }
        } else if (parsedCurrentDisplay) {
          // Only current display price found. This should be the main price.
          price = parsedCurrentDisplay.amount;
          currency = parsedCurrentDisplay.currency;
          salePrice = undefined;
          log.debug(`   Only current display price found ('${currentDisplayPriceText}'). Setting as main price. Source: ${sourceUrl}`);
        } else if (parsedOriginal) {
          // Only original_price_on_sale_page selector yielded a price, but current_display_price did not.
          // This implies it is the regular price, not a sale.
          price = parsedOriginal.amount;
          currency = parsedOriginal.currency;
          salePrice = undefined;
          log.debug(`   Only original_price_on_sale_page selector yielded price ('${originalPriceText}'). Setting as main price. Source: ${sourceUrl}`);
        } else {
          // Fallback: Try the generic regular price selector if others fail
          const regularPriceText = await priceContainer.$eval(SELECTORS.product.price.regular_price_not_on_sale, el => el.getAttribute('data-value') || el.textContent?.trim() || null).catch(() => null);
          const parsedRegular = parsePrice(regularPriceText);
          if (parsedRegular) {
            price = parsedRegular.amount;
            currency = parsedRegular.currency;
          } else {
            log.error(`   Price could not be determined for ${sourceUrl}. All attempts failed.`);
          }
        }

        if (price === 0 && salePrice === undefined) {
          log.error(`   Final price is 0 and no sale price for ${sourceUrl}. Review price logic and selectors.`);
        }

      } else {
        log.error(`   Price container not found for ${sourceUrl}`);
      }
    } catch (e) {
      log.error(`   Price scraping error for ${sourceUrl}: ${(e as Error).message}`);
    }

    // Image handling with existing images support
    let imagesWithMushUrl: { sourceUrl: string; mushUrl?: string; alt_text?: string }[];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
      log.debug(`Using ${options.existingImages.length} existing images from database`);
      imagesWithMushUrl = options.existingImages.map(img => ({
        sourceUrl: img.sourceUrl,
        mushUrl: img.mushUrl,
        alt_text: undefined
      }));
    } else {
      // Normal image scraping flow
      const imagesData: { sourceUrl: string; alt_text: string }[] = await page.$$eval(
        SELECTORS.product.images.container,
        (imageElements, data) => { // data = { productTitle, urlAttr, altAttr, base }
          const collectedImages: { sourceUrl: string; alt_text: string }[] = [];
          const uniqueUrls = new Set<string>();

          imageElements.forEach((imgEl: Element) => {
            const img = imgEl as HTMLImageElement;
            let imageUrl: string | null = img.getAttribute(data.urlAttr);

            // If the image is wrapped in an <a> tag for fancybox, prefer the href if it's a direct image link
            const parentAnchor = img.closest('a');
            if (parentAnchor) {
              const anchorHref = parentAnchor.getAttribute('href');
              if (anchorHref && /\.(jpeg|jpg|gif|png|webp)(\?|$)/i.test(anchorHref)) {
                imageUrl = anchorHref;
              }
            }

            if (imageUrl) {
              try {
                // Resolve relative URLs
                const absoluteUrl = new URL(imageUrl, data.base).href;
                if (!uniqueUrls.has(absoluteUrl)) {
                  uniqueUrls.add(absoluteUrl);
                  collectedImages.push({
                    sourceUrl: absoluteUrl,
                    alt_text: img.getAttribute(data.altAttr)?.trim() || data.productTitle,
                  });
                }
              } catch (e) {
                log.error(`   Error normalizing image URL ${imageUrl} for ${data.productTitle}: ${(e as Error).message}`);
              }
            }
          });
          return collectedImages;
        },
        { productTitle: title, urlAttr: SELECTORS.product.images.sourceUrl, altAttr: SELECTORS.product.images.alt, base: page.url() }
      ).catch((e) => {
        log.error(`   Error evaluating images for ${sourceUrl}: ${(e as Error).message}`);
        return [];
      });

      if (options?.uploadToS3 !== false) {
        imagesWithMushUrl = await uploadImagesToS3AndAddUrls(imagesData, sourceUrl);
      } else {
        // Skip S3 upload, just use scraped images with sourceUrl only
        imagesWithMushUrl = imagesData;
      }
    }

    let sizes: Size[] = [];
    try {
      const sizeGroupElements = await page.$$(SELECTORS.product.sizes.sizeGroupContainer);
      for (const groupElement of sizeGroupElements) {
        // const groupName = await groupElement.$eval(SELECTORS.product.sizes.sizeNameHeader, el => el.textContent?.trim() || '').catch(() => '');
        const sizeOptions = await groupElement.$$(SELECTORS.product.sizes.options);

        for (const optionElement of sizeOptions) {
          const sizeLabelElement = await optionElement.$(SELECTORS.product.sizes.label);
          const sizeValue = await sizeLabelElement?.evaluate(el => el.textContent?.trim() || '') || '';

          // For availability, check if the input radio button is disabled.
          // This is a common pattern, but might need adjustment if the site uses classes for unavailability.
          const inputElement = await optionElement.$('input[type="radio"]');
          const isDisabled = await inputElement?.isDisabled().catch(() => true); // Assume disabled if error or not found
          const isAvailable = !isDisabled;

          if (sizeValue) {
            sizes.push({
              size: sizeValue, // If groupName, could be: `${groupName}: ${sizeValue}`
              is_available: isAvailable,
            });
          }
        }
      }
      // Deduplicate sizes based on the size value, prioritizing available ones if duplicates exist
      const uniqueSizesMap = new Map<string, Size>();
      for (const s of sizes) {
        const existing = uniqueSizesMap.get(s.size);
        if (!existing || (existing && !existing.is_available && s.is_available)) {
          uniqueSizesMap.set(s.size, s);
        }
      }
      sizes = Array.from(uniqueSizesMap.values());

    } catch (e) {
      log.error(`   Error during size extraction for ${sourceUrl}: ${(e as Error).message}`);
    }

    const finalItem: Item = {
      sourceUrl,
      product_id: vendorCode,
      title,
      description: descriptionHTML,
      images: imagesWithMushUrl,
      price,
      sale_price: salePrice,
      currency,
      sizes: sizes.length > 0 ? sizes : undefined,
      vendor: 'blackseatribe',
      status: sizes.length > 0 ? (sizes.some(s => s.is_available) ? 'ACTIVE' : 'DELETED') : 'ACTIVE', // Or 'INACTIVE' if no sizes
      tags: [] // Add tags if applicable/extractable
    };

    return Utils.formatItem(finalItem);

  } catch (error) {
    log.error(`Error scraping item at ${sourceUrl}: ${(error as Error).message}`);
    // Rethrow or return a specific error structure if needed by the caller
    throw error;
  }
}

const scraper: Scraper = {
  getItemUrls,
  paginate,
  scrapeItem
};

export default scraper; 