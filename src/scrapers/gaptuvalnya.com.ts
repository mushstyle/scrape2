import type { Page } from 'playwright';
import type { Item, Image, Size } from '../types/item.js';
import * as Utils from '../db/db-utils.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('gaptuvalnya.com');

const SELECTORS = {
  productListItem: 'div.col-md-4.catalog',
  productLink: 'a', // Relative to productListItem
  nextPageLink: 'ul.pagination a.next',
  // Item Page Selectors (using common WooCommerce patterns for elements not in provided snippets)
  title: 'div.summary.entry-summary h1',
  priceContainer: 'div.summary p.price', // The text content of this element will be parsed
  description: 'div.woocommerce-product-details__short-description',
  imagesContainer: 'div.images div.slick-track.woocommerce-product-gallery__image', // Main gallery container
  imageSlide: 'div.zoom.slick-slide', // Individual image slides
  imageLink: 'a.wpgis-popup', // High-res image link within a slide
  imageTagForAlt: 'img.wp-post-image[src]', // Image tag within a slide for alt text
  sku: 'span.sku', // Common selector for SKU
  sizeOptions: 'select#pa_rozmir option', // Selector for size options
};

/**
 * Parses price text, handling single values and ranges (takes lower value of range).
 * Expected format: "123€" or "123€ - 456€".
 */
const parsePrice = (priceText: string | null | undefined): number | undefined => {
  if (!priceText) return undefined;

  const rangeMatch = priceText.match(/([\d,]+(?:\.\d{1,2})?)\s*€\s*–\s*([\d,]+(?:\.\d{1,2})?)\s*€/);
  if (rangeMatch && rangeMatch[1]) {
    const lowerPriceString = rangeMatch[1].replace(/,/g, '');
    return parseFloat(lowerPriceString);
  }

  const singleMatch = priceText.match(/([\d,]+(?:\.\d{1,2})?)\s*€/);
  if (singleMatch && singleMatch[1]) {
    const priceString = singleMatch[1].replace(/,/g, '');
    return parseFloat(priceString);
  }

  log.error(`Could not parse price from: "${priceText}"`);
  return undefined;
};

export async function getItemUrls(page: Page): Promise<Set<string>> {
  const itemUrls = new Set<string>();
  try {
    // Try to wait for products with a shorter timeout
    await page.waitForSelector(SELECTORS.productListItem, { timeout: 5000 });
    const productElements = await page.$$(SELECTORS.productListItem);

    for (const elHandle of productElements) {
      const linkElement = await elHandle.$(SELECTORS.productLink);
      if (linkElement) {
        const hrefAttr = await linkElement.getAttribute('href');
        if (hrefAttr) {
          try {
            itemUrls.add(new URL(hrefAttr, page.url()).href);
          } catch (e) {
            log.error(`Invalid URL found: ${hrefAttr} on page ${page.url()}`);
          }
        }
      }
    }
    
    if (productElements.length === 0) {
      log.debug(`No products found on ${page.url()}`);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    
    // Check if it's a timeout waiting for products - this could be normal for empty pages
    if (errorMessage.includes('Timeout') && errorMessage.includes(SELECTORS.productListItem)) {
      log.debug(`No products found on ${page.url()} (timeout waiting for selector)`);
    } else {
      log.error(`Error in getItemUrls for ${page.url()}: ${errorMessage}`);
    }
  }
  return itemUrls;
}

export async function paginate(page: Page): Promise<boolean> {
  try {
    // First check if there's a next page link
    const nextButton = await page.$(SELECTORS.nextPageLink);
    if (!nextButton) {
      log.debug('No next page link found');
      return false;
    }
    
    const hrefAttr = await nextButton.getAttribute('href');
    if (!hrefAttr) {
      log.debug('Next page link has no href attribute');
      return false;
    }
    
    const nextPageUrl = new URL(hrefAttr, page.url()).href;
    
    // Try to navigate to the next page with a shorter timeout
    try {
      const response = await page.goto(nextPageUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
      
      // Check if response is valid
      if (!response || !response.ok()) {
        log.debug(`Non-OK response for next page (status: ${response?.status()})`);
        return false;
      }
      
      // Wait a bit for content to load
      await page.waitForTimeout(1000);
      
      // Check if there are products on this page
      try {
        await page.waitForSelector(SELECTORS.productListItem, { timeout: 3000 });
        return true; // Products found, pagination successful
      } catch {
        // No products found within timeout
        log.debug('No products found on next page');
        return false;
      }
    } catch (navError) {
      // Navigation failed - could be end of pages or network issue
      const errorMessage = navError instanceof Error ? navError.message : String(navError);
      
      // Check if it's a timeout - might indicate end of pages
      if (errorMessage.includes('Timeout')) {
        log.debug(`Pagination timeout - likely end of pages: ${nextPageUrl}`);
      } else {
        log.error(`Pagination navigation error: ${errorMessage}`);
      }
      return false;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error(`Pagination error on ${page.url()}: ${errorMessage}`);
    return false;
  }
}

export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item[]> {
  const sourceUrl = page.url();

  await page.waitForSelector(SELECTORS.title, { timeout: 10000 });

  type RawItemData = {
    title: string | null;
    priceText: string | null;
    descriptionHTML: string | null;
    imagesData: { sourceUrl: string; altText: string | null }[];
    sku: string | null;
    sizesRaw: { size: string; is_available: boolean }[]; // Added for sizes
  };

  const rawData = await page.evaluate((selectors: typeof SELECTORS): RawItemData => {
    const title = document.querySelector(selectors.title)?.textContent?.trim() || null;
    const priceContainer = document.querySelector(selectors.priceContainer);
    const priceText = priceContainer?.textContent?.trim() || null;
    const descriptionElement = document.querySelector(selectors.description);
    const descriptionHTML = descriptionElement?.innerHTML || null;
    const imagesData: { sourceUrl: string; altText: string | null }[] = [];
    const imageGallery = document.querySelector(selectors.imagesContainer);

    if (imageGallery) {
      const imageSlides = imageGallery.querySelectorAll(selectors.imageSlide);
      imageSlides.forEach(slide => {
        const linkEl = slide.querySelector(selectors.imageLink) as HTMLAnchorElement;
        let imageUrl = linkEl?.href || null;

        if (!imageUrl) {
          const imgEl = slide.querySelector(selectors.imageTagForAlt) as HTMLImageElement;
          if (imgEl?.src) {
            imageUrl = imgEl.src;
          }
        }

        const altText = slide.querySelector(selectors.imageTagForAlt)?.getAttribute('alt')?.trim() || title;

        if (imageUrl) {
          try {
            const absoluteImageUrl = new URL(imageUrl, document.baseURI).href;
            if (!imagesData.some(img => img.sourceUrl === absoluteImageUrl)) {
              imagesData.push({ sourceUrl: absoluteImageUrl, altText });
            }
          } catch (e) {
            // invalid URL, ignore
          }
        }
      });
    }

    const sku = document.querySelector(selectors.sku)?.textContent?.trim() || null;

    // Size extraction
    const sizeOptionElements = document.querySelectorAll(selectors.sizeOptions);
    const sizesRaw = Array.from(sizeOptionElements).map(option => {
      const opt = option as HTMLOptionElement;
      return {
        size: opt.textContent?.trim() || '',
        is_available: !opt.disabled && opt.value !== '' // Ensure it's not the placeholder "Choose an option"
      };
    }).filter(s => s.size && s.size.toLowerCase() !== 'choose an option');

    return { title, priceText, descriptionHTML, imagesData, sku, sizesRaw };
  }, SELECTORS);

  const price = parsePrice(rawData.priceText);
  const currency = 'EUR';

  if (!rawData.title) {
    throw new Error(`Title not found for item at ${sourceUrl}`);
  }
  if (price === undefined) {
    log.error(`Price could not be parsed for item at ${sourceUrl}. Price text was: "${rawData.priceText}"`);
  }

  const imageInputForS3: Omit<Image, 'mushUrl'>[] = rawData.imagesData.map(img => ({
    sourceUrl: img.sourceUrl,
    alt_text: img.altText || rawData.title || '',
  }));

  // Image handling with existing images support
    let uploadedImages: Image[];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
      logger.normal(`[gaptuvalnya.com] Using ${options.existingImages.length} existing images from database`);
      uploadedImages = options.existingImages.map(img => ({
        sourceUrl: img.sourceUrl,
        mushUrl: img.mushUrl,
        alt_text: undefined
      }));
    } else {
      if (options?.uploadToS3 !== false) {

        uploadedImages = await uploadImagesToS3AndAddUrls(imageInputForS3, 'gaptuvalnya.com');

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        uploadedImages = imageInputForS3;

      }
    }

  const descriptionCleaned = rawData.descriptionHTML === null ? undefined : rawData.descriptionHTML;

  const sizes: Size[] = rawData.sizesRaw.map(s => ({
    size: s.size,
    is_available: s.is_available,
  }));

  const item: Item = {
    sourceUrl,
    title: rawData.title,
    price: price ?? 0,
    currency,
    description: descriptionCleaned,
    images: uploadedImages,
    product_id: rawData.sku || sourceUrl,
    sizes: sizes,
  };

  return [Utils.formatItem(item)];
}

const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem,
};

export default scraper; 