import type { Page } from 'playwright';
import type { Scraper } from './types.js';
import type { Item, Size, Image } from '../types/item.js';
// import playwright from 'playwright'; // Removed playwright
import { formatItem } from '../db/db-utils.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import { logger } from '../utils/logger.js';
// import { getSiteConfig } from '../diagnostics/site-utils.js'; // Uncomment if needed

export async function getItemUrls(page: Page): Promise<Set<string>> {
  // Wait for product items to be present
  await page.waitForSelector('ul.products li.product a.woocommerce-LoopProduct-link', { timeout: 10000 });

  const productLinks = await page.evaluate(() => {
    const hrefs: string[] = [];
    document.querySelectorAll('ul.products li.product a.woocommerce-LoopProduct-link').forEach(anchor => {
      if (anchor && (anchor instanceof HTMLAnchorElement) && anchor.href) {
        hrefs.push(anchor.href); // These URLs are already absolute
      }
    });
    return hrefs;
  });

  // URLs are already absolute, so a simple Set creation is enough for deduplication here.
  const uniqueUrls = new Set(productLinks);
  const log = logger.createContext('themakers.com.ua');
  log.debug(`[getItemUrls] Found ${uniqueUrls.size} product URLs on ${page.url()}`);
  return uniqueUrls;
}

export async function paginate(page: Page): Promise<boolean> {
  const log = logger.createContext('themakers.com.ua');
  try {
    // Look for the "Next" button in the pagination
    const nextButtonSelector = 'nav.woocommerce-pagination a.next.page-numbers';
    const nextButton = page.locator(nextButtonSelector).first();

    if (!await nextButton.isVisible()) {
      log.debug(`[paginate] "Next" button not visible on ${page.url()}. Reached last page.`);
      return false;
    }

    const nextUrl = await nextButton.getAttribute('href');
    if (!nextUrl) {
      log.debug(`[paginate] "Next" button has no href attribute on ${page.url()}.`);
      return false;
    }

    log.debug(`[paginate] Navigating to next page: ${nextUrl}`);

    // Navigate to the next page
    await page.goto(nextUrl, { waitUntil: 'domcontentloaded' });

    // Wait for products to load on the new page
    await page.waitForSelector('ul.products li.product a.woocommerce-LoopProduct-link', { timeout: 10000 });

    log.debug(`[paginate] Successfully navigated to ${page.url()}`);
    return true;

  } catch (error) {
    log.error(`[paginate] Error during pagination on ${page.url()}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item[]> {
  const sourceUrl = page.url();
  const parsePrice = (priceText: string | null | undefined): number | undefined => {
    if (!priceText) return undefined;
    const cleanedPrice = priceText.replace(/[^\d.,]+/g, '').replace(',', '.').trim();
    const priceNumber = parseFloat(cleanedPrice);
    return isNaN(priceNumber) ? undefined : priceNumber;
  };

  try {
    // Page is already at sourceUrl. Caller should ensure networkidle if needed.
    await page.waitForSelector('div.product.type-product', { timeout: 10000 });

    const rawDetails = await page.evaluate(() => {
      const productRoot = document.querySelector('div.product.type-product');
      if (!productRoot) {
        return {
          title: '', priceText: null, description: '', images: [], sizesRaw: [], currencySymbol: 'UAH', sku: null,
        };
      }

      const title = productRoot.querySelector('h1.product_title.entry-title')?.textContent?.trim() || '';
      const priceText = productRoot.querySelector('p.price span.woocommerce-Price-amount bdi')?.textContent?.trim() || null;

      let description = productRoot.querySelector('div.woocommerce-product-details__short-description p')?.textContent?.trim() || '';
      const longDescriptionEl = productRoot.querySelector('div.woocommerce-Tabs-panel--description p');
      if (longDescriptionEl && longDescriptionEl.textContent?.trim()) {
        description = longDescriptionEl.textContent.trim();
      }
      if (!description) { // Fallback to trying to get any text from the description tab panel
        description = productRoot.querySelector('div.woocommerce-Tabs-panel--description')?.textContent?.trim() || '';
      }


      const images: Array<{ src: string | null; alt: string | null }> = [];
      productRoot.querySelectorAll('.woocommerce-product-gallery__wrapper .woocommerce-product-gallery__image a').forEach(anchor => {
        if (anchor instanceof HTMLAnchorElement && anchor.href) {
          const img = anchor.querySelector('img');
          images.push({
            src: anchor.href,
            alt: img ? img.alt : title
          });
        }
      });
      if (images.length === 0) {
        const singleImg = productRoot.querySelector('.woocommerce-product-gallery__image img');
        if (singleImg instanceof HTMLImageElement && singleImg.src) {
          images.push({ src: singleImg.src, alt: singleImg.alt || title });
        }
      }

      const sizesRaw: Array<{ name: string; available: boolean }> = [];
      const variationsJson = (document.querySelector('form.variations_form.cart') as HTMLElement)?.dataset.product_variations;
      if (variationsJson) {
        try {
          const variations = JSON.parse(variationsJson);
          variations.forEach((variation: any) => {
            if (variation.attributes && variation.attributes.attribute_pa_size) {
              sizesRaw.push({
                name: variation.attributes.attribute_pa_size.toUpperCase(), // Assuming S, M, L come from here
                available: variation.is_in_stock === true
              });
            }
          });
        } catch (e) {
          const log = logger.createContext('themakers.com.ua');
          log.error(`Error parsing product_variations JSON: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Fallback or supplemental: Read from the additional information table
      if (sizesRaw.length === 0) {
        productRoot.querySelectorAll('table.woocommerce-product-attributes tr.woocommerce-product-attributes-item--attribute_pa_size td p').forEach(pElement => {
          const sizeText = pElement.textContent?.trim();
          if (sizeText) {
            sizeText.split(',').forEach(s => {
              const trimmedSize = s.trim().toUpperCase();
              if (trimmedSize && !sizesRaw.find(sr => sr.name === trimmedSize)) { // Avoid duplicates if JSON already populated some
                sizesRaw.push({ name: trimmedSize, available: true }); // Assume available if listed here and not in JSON
              }
            });
          }
        });
      }

      const currencySymbol = priceText?.includes('₴') ? '₴' : (priceText?.match(/[A-Z]{3}/)?.[0] || 'UAH');
      const sku = productRoot.querySelector('.sku_wrapper .sku')?.textContent?.trim() || null;

      return {
        title,
        priceText,
        description,
        images,
        sizesRaw,
        currencySymbol,
        sku
      };
    });

    const price = parsePrice(rawDetails.priceText);
    let currency = 'UAH';
    if (rawDetails.currencySymbol === '₴') {
      currency = 'UAH';
    } else if (rawDetails.currencySymbol && /^[A-Z]{3}$/.test(rawDetails.currencySymbol)) {
      currency = rawDetails.currencySymbol;
    }

    // Image handling with existing images support
    let productImages: Image[];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
      const log = logger.createContext('themakers.com.ua');
      log.debug(`Using ${options.existingImages.length} existing images from database`);
      productImages = options.existingImages.map(img => ({
        sourceUrl: img.sourceUrl,
        mushUrl: img.mushUrl,
        alt_text: undefined
      }));
    } else {
      // Normal image scraping flow
      const validImagePayloads = rawDetails.images
        .filter(img => img.src && img.src.startsWith('http'))
        .map(img => ({ sourceUrl: img.src as string, altText: img.alt || rawDetails.title }));

      if (options?.uploadToS3 !== false) {


        productImages = await uploadImagesToS3AndAddUrls(
        validImagePayloads,
        sourceUrl
      );


      } else {


        // Skip S3 upload, just use scraped images with sourceUrl only


        productImages = validImagePayloads;


      }
    }

    const sizes: Size[] = rawDetails.sizesRaw.map(s => ({
      size: s.name,
      is_available: s.available,
    }));

    const productId = rawDetails.sku || new URL(sourceUrl).pathname.split('/').filter(Boolean).pop() || sourceUrl;

    const item: Item = {
      sourceUrl: sourceUrl,
      product_id: productId,
      title: rawDetails.title,
      price: price ?? 0,
      sale_price: undefined,
      currency,
      description: rawDetails.description,
      images: productImages,
      sizes: sizes.length > 0 ? sizes : undefined, // Set to undefined if no sizes found
    };

    return [formatItem(item)];

  } finally {
    // await browser.close(); // Browser lifecycle managed by the caller
  }
}

const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem,
};

export default scraper; 