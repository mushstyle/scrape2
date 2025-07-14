import type { Page } from 'playwright';
// import { chromium } from 'playwright'; // Removed chromium
import type { Item, Image, Size } from '../types/item.js'; // Corrected path to types
import type { Scraper } from './types.js'; // Corrected path for Scraper type
// import { getSiteConfig } from '../diagnostics/site-utils.js'; // Removed getSiteConfig
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js'; // Adjust path if necessary
import * as Utils from '../db/db-utils.js'; // Adjust path if necessary
import { logger } from '../lib/logger.js';

const log = logger.createContext('grainsdeverre.com');

// Helper function for parsing price strings
const parsePrice = (text: string | null | undefined): number | undefined => {
  if (!text) return undefined;
  // Remove currency symbols (like $, €, ₴), non-breaking spaces, regular spaces, and letters
  // Replace comma decimal separator with a dot if necessary
  const cleaned = text.replace(/[$€₴\s\u00A0A-Za-z]+/g, '').replace(',', '.');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? undefined : parsed;
};

export async function getItemUrls(page: Page): Promise<Set<string>> {
  await page.waitForSelector('a.gdv-home-single-product-link', { timeout: 10000 });

  const urls = await page.evaluate(() => {
    const productLinks = document.querySelectorAll<HTMLAnchorElement>('a.gdv-home-single-product-link');
    const urls: string[] = [];

    productLinks.forEach(link => {
      if (link.href) {
        // Resolve URL within evaluate
        urls.push(new URL(link.href, document.baseURI).href);
      }
    });
    return urls;
  });

  // No need for ensureValidUrl here as URLs are resolved in evaluate
  return new Set(urls);
}

export async function paginate(page: Page): Promise<boolean> {
  // grainsdeverre.com loads all products on a single page
  return false;
}

export const scrapeItem = async (page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> => {
  const sourceUrl = page.url();
  try {
    // Page is already at sourceUrl. Caller should ensure DOM is loaded.
    await page.waitForSelector('.gdv-single-product-wrapper', { timeout: 10000 });

    // Specific wait for the price element to ensure it's ready for the DOM fallback inside evaluate.
    try {
      // Use a more general selector for the price container, or a specific one for actual price elements
      await page.waitForSelector('p.price span.woocommerce-Price-amount', { state: 'visible', timeout: 7000 });
    } catch (e: any) {
      log.error(`Warning: Price element for DOM fallback not visible within timeout for ${sourceUrl}: ${e.message}`);
      // Continue, as the JSON path might still work.
    }

    // Extract RAW data within evaluate
    const rawDetails = await page.evaluate(() => {
      const title = document.querySelector('.gdv-single-product-title-block')?.textContent?.trim() || '';
      const descriptionElement = document.querySelector('.gdv-single-product-short-description');
      const description = descriptionElement?.textContent?.trim() || '';

      let jsonPriceText: string | null = null; // Renamed for clarity
      let currencySymbol: string = 'UAH'; // Default currency symbol

      // Attempt 1: Parse from data-product_variations JSON
      const variationsForm = document.querySelector('form.variations_form');
      const variationIdInput = document.querySelector('input.variation_id');
      const selectedVariationId = variationIdInput instanceof HTMLInputElement ? variationIdInput.value : null;
      const variationsJsonString = variationsForm instanceof HTMLElement ? variationsForm.dataset.product_variations : null;

      if (selectedVariationId && variationsJsonString) {
        try {
          const variations = JSON.parse(variationsJsonString);
          const selectedVariation = variations.find((v: any) => v.variation_id.toString() === selectedVariationId);

          if (selectedVariation && typeof selectedVariation.display_price !== 'undefined') {
            jsonPriceText = selectedVariation.display_price.toString();

            if (selectedVariation.price_html) {
              const symbolMatch = selectedVariation.price_html.match(/<span class="woocommerce-Price-currencySymbol">(.*?)<\/span>/);
              if (symbolMatch && symbolMatch[1]) {
                const tempEl = document.createElement('textarea');
                tempEl.innerHTML = symbolMatch[1];
                currencySymbol = tempEl.value;
              }
            }
          }
        } catch (e: any) {
          log.error(`Error parsing product variations JSON for ${document.location.href}: ${e.message}`);
        }
      }

      // DOM fallback variables / or primary source for original/sale structure
      let domOriginalPriceText: string | null = null;
      let domSalePriceText: string | null = null;
      let domRegularPriceText: string | null = null;

      const priceContainer = document.querySelector('p.price');
      if (priceContainer) {
        const originalPriceElement = priceContainer.querySelector('del span.woocommerce-Price-amount');
        if (originalPriceElement) {
          domOriginalPriceText = originalPriceElement.textContent?.trim() || null;
          const symbolEl = originalPriceElement.querySelector('span.woocommerce-Price-currencySymbol');
          if (currencySymbol === 'UAH' && symbolEl && symbolEl.textContent) {
            const tempDecodeEl = document.createElement('textarea');
            tempDecodeEl.innerHTML = symbolEl.textContent.trim();
            currencySymbol = tempDecodeEl.value;
          }
        }

        const salePriceElement = priceContainer.querySelector('ins span.woocommerce-Price-amount');
        if (salePriceElement) {
          domSalePriceText = salePriceElement.textContent?.trim() || null;
          const symbolEl = salePriceElement.querySelector('span.woocommerce-Price-currencySymbol');
          if (currencySymbol === 'UAH' && symbolEl && symbolEl.textContent) {
            const tempDecodeEl = document.createElement('textarea');
            tempDecodeEl.innerHTML = symbolEl.textContent.trim();
            currencySymbol = tempDecodeEl.value;
          }
        }

        if (!domSalePriceText) { // Only look for regular if no explicit sale price found
          const priceElements = Array.from(priceContainer.querySelectorAll('span.woocommerce-Price-amount'));
          for (const el of priceElements) {
            if (!el.closest('del') && !el.closest('ins')) {
              domRegularPriceText = el.textContent?.trim() || null;
              const symbolEl = el.querySelector('span.woocommerce-Price-currencySymbol');
              if (currencySymbol === 'UAH' && symbolEl && symbolEl.textContent) {
                const tempDecodeEl = document.createElement('textarea');
                tempDecodeEl.innerHTML = symbolEl.textContent.trim();
                currencySymbol = tempDecodeEl.value;
              }
              break;
            }
          }
        }
      }

      const imageElements = Array.from(document.querySelectorAll<HTMLImageElement>('.swiper-slide.gdv-main-slider-slide img.gdv-single-gallery-image-product'));
      const imagesRaw = imageElements.map((img: HTMLImageElement) => {
        const url = img.dataset.src || img.src || '';
        const alt_text = img.alt || title;
        return { sourceUrl: url, alt_text };
      }).filter((img): img is { sourceUrl: string; alt_text: string } => !!img.sourceUrl && !img.sourceUrl.startsWith('data:'));

      const sourceIdElement = document.querySelector<HTMLButtonElement>('form.cart button[name="add-to-cart"]');
      const sourceId = sourceIdElement?.value || '';

      // Extract sizes using { size: string, is_available: boolean } structure for Size type
      const sizes: Size[] = [];
      const sizeOptionElements = Array.from(document.querySelectorAll<HTMLLIElement>('ul.variable-items-wrapper[data-attribute_name="attribute_pa_rozmir"] li.variable-item'));
      sizeOptionElements.forEach((el: HTMLLIElement) => {
        const value = el.dataset.value;
        if (value) {
          const is_available = typeof el.dataset.wvstooltipOutOfStock !== 'undefined' && el.dataset.wvstooltipOutOfStock === '';
          sizes.push({ size: value, is_available });
        }
      });

      return {
        title,
        description,
        jsonPriceText, // from JSON product_variations
        domOriginalPriceText,
        domSalePriceText,
        domRegularPriceText,
        currencySymbol,
        imagesRaw,
        sourceId,
        sizes,
      };
    });

    // --- Parse prices in Node.js context ---
    const jsonPriceVal = parsePrice(rawDetails.jsonPriceText);
    const domOriginalVal = parsePrice(rawDetails.domOriginalPriceText);
    const domSaleVal = parsePrice(rawDetails.domSalePriceText);
    const domRegularVal = parsePrice(rawDetails.domRegularPriceText);

    let determinedPrice: number | undefined;
    let determinedSalePrice: number | undefined;

    if (jsonPriceVal !== undefined) {
      if (domOriginalVal !== undefined && jsonPriceVal < domOriginalVal) {
        determinedPrice = domOriginalVal;
        determinedSalePrice = jsonPriceVal;
      } else {
        determinedPrice = jsonPriceVal;
      }
    } else {
      if (domSaleVal !== undefined) {
        if (domOriginalVal !== undefined) {
          determinedPrice = domOriginalVal;
          determinedSalePrice = domSaleVal;
        } else {
          determinedPrice = domSaleVal; // Only <ins>, no <del>, so it's the current price
        }
      } else if (domRegularVal !== undefined) {
        determinedPrice = domRegularVal;
      } else if (domOriginalVal !== undefined) {
        // Only a <del> price found. Current selling price is not clear.
        // determinedPrice remains undefined, will trigger error below.
      }
    }

    // Map currency symbol to code
    let currency = 'UAH'; // Default
    if (rawDetails.currencySymbol === '€') currency = 'EUR';
    else if (rawDetails.currencySymbol === '$') currency = 'USD';
    else if (rawDetails.currencySymbol === '₴') currency = 'UAH'; // Explicit for clarity
    // Add other mappings if needed

    if (determinedPrice === undefined || !rawDetails.title) { // Check determined price
      throw new Error(`Failed to extract current selling price or title from ${sourceUrl}`);
    }

    // Image handling with existing images support
    let imagesWithMushUrl: Image[];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
      log.normal(`Using ${options.existingImages.length} existing images from database`);
      imagesWithMushUrl = options.existingImages.map(img => ({
        sourceUrl: img.sourceUrl,
        mushUrl: img.mushUrl,
        alt_text: undefined
      }));
    } else {
      if (options?.uploadToS3 !== false) {

        imagesWithMushUrl = await uploadImagesToS3AndAddUrls(rawDetails.imagesRaw, sourceUrl);

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        imagesWithMushUrl = rawDetails.imagesRaw;

      }
    }

    const item: Item = {
      sourceUrl,
      product_id: rawDetails.sourceId || `${rawDetails.title}-${determinedPrice}`, // Use determined price in fallback ID
      title: rawDetails.title,
      description: rawDetails.description,
      images: imagesWithMushUrl,
      price: determinedPrice,
      sale_price: determinedSalePrice,
      currency: currency,
      sizes: rawDetails.sizes.length > 0 ? rawDetails.sizes : undefined,
      vendor: 'grainsdeverre', // Use domain name as vendor
    };

    return Utils.formatItem(item);

  } finally {
    // await browser.close(); // Browser lifecycle managed by the caller
  }
};

const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper; 