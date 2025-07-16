import type { Page } from 'playwright';
import type { Item, Image, Size } from '../types/item.js';
import * as Utils from '../db/db-utils.js';
// import { getSiteConfig, extractDomain } from '../diagnostics/site-utils.js'; // No longer needed
import { uploadImageUrlToS3 } from '../providers/s3.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('ua.lowposh.com');

/**
 * This file follows the page-pagination template.
 */

export const SELECTORS = {
  // Product listing page selectors
  productGrid: '.js-grid, .grid--view-items', // Multiple grid selectors for fallback
  productLinks: '.product-grid-item__content a[href*="/products/"], .grid-view-item a[href*="/products/"]', // Multiple link selectors
  pagination: {
    type: 'numbered' as const,
    pattern: 'page={n}'
  },
  // Individual product page selectors
  product: {
    title: '.product__title',
    price: '[data-product-price]',
    images: '[data-product-image], .product-single__photo img',
    // Size selectors
    sizesWrapper: '.selector-wrapper:not(.selector-wrapper--color)',
    sizeInputs: 'input[name^="options"][value]',
    sizeLegend: '.radio__legend__label',
    // Color selectors
    colorsWrapper: '.selector-wrapper--color',
    colorInputs: 'input[name^="options"][value]',
    // Description selectors
    description: '.product__block__description.rte--column p'
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
 * Paginates using page parameter, checks for content on next page, returns status.
 * @param page Playwright page object
 * @returns boolean indicating if pagination was successful and next page has content.
 */
export async function paginate(page: Page): Promise<boolean> {
  const currentUrl = page.url();
  const url = new URL(currentUrl);
  const pageParam = url.searchParams.get('page');
  const currentPage = pageParam ? parseInt(pageParam) : 1;
  const nextPage = currentPage + 1;
  let nextUrl: string = currentUrl; // Initialize for logging

  try {
    log.debug(`==== Paginating from page: ${currentPage} ====`);
    log.debug(`Current URL: ${currentUrl}`);

    // Construct next page URL
    url.searchParams.set('page', nextPage.toString());
    nextUrl = url.toString();
    log.debug(`Next URL: ${nextUrl}`);

    // Navigate to next page
    log.debug(`Navigating to page ${nextPage}...`);
    const response = await page.goto(nextUrl, {
      waitUntil: 'domcontentloaded', // Use domcontentloaded for faster initial response
      timeout: 10000
    });

    if (!response || !response.ok()) {
      log.debug(`   Pagination failed: Non-OK response for ${nextUrl} (status: ${response?.status()})`);
      return false;
    }

    // Wait a moment for dynamic content loading (if any)
    await page.waitForTimeout(2000);
    log.debug('Checking for products on next page...');

    // Try to wait for the product links - this is the primary check for content
    await page.waitForSelector(SELECTORS.productLinks, { timeout: 10000, state: 'visible' });
    log.debug('   Product links selector found on next page.');

    log.debug(`   Successfully navigated to next page: ${nextUrl}`);
    return true; // Navigation succeeded, product links found

  } catch (error) {
    // Check if the error is a timeout waiting for product links, indicating no more items
    if (error instanceof Error && error.message.includes('Timeout') && error.message.includes(SELECTORS.productLinks)) {
      log.debug(`   Pagination likely ended: Product links selector (${SELECTORS.productLinks}) not found on ${nextUrl}`);
    } else {
      // Log other errors (e.g., navigation errors)
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`   Pagination failed for ${nextUrl}: ${errorMessage}`);
    }
    return false; // Indicate failure
  }
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

    // Wait for critical elements (only if not 404)
    await page.waitForSelector(SELECTORS.product.title);
    await page.waitForSelector(SELECTORS.product.price);

    // Extract product data from JSON script
    const productJson = await page.$eval('script[type="application/json"][data-product-json]', el => {
      return JSON.parse(el.textContent || '{}');
    });

    if (!productJson || !productJson.variants) {
      log.debug('Product JSON or variants not found. Falling back to DOM scraping for some fields.');
    }

    // Extract title
    const title = productJson?.title || await page.$eval(SELECTORS.product.title, el => el.textContent?.trim() || '');

    // Extract price - remove currency symbol and convert to number
    const priceText = productJson?.price ? (productJson.price / 100).toFixed(2) : await page.$eval(SELECTORS.product.price, el => el.textContent?.trim() || '');
    const currencySymbol = priceText.match(/[^\d\s.,]/)?.[0] || '₴'; // Assumes price from JSON is in cents
    const price = parseFloat(priceText.replace(/[^\d.,]/g, '').replace(/,/g, ''));

    // Extract images
    // Use productJson.images if available, else fallback to DOM
    let images: Image[] = [];
    if (productJson?.media && Array.isArray(productJson.media)) {
      images = productJson.media
        .filter((mediaItem: any) => mediaItem.media_type === 'image' && mediaItem.src)
        .map((mediaItem: any) => ({
          sourceUrl: mediaItem.src.replace(/_\d+x\d+\./, '.').replace(/_compact\./, '.'), // Generalize URL cleaning
          alt_text: mediaItem.alt || title,
        }));
    } else {
      images = await page.$$eval(SELECTORS.product.images, (els, pageTitle) =>
        els.map(el => ({
          sourceUrl: ((el as HTMLImageElement).src).replace(/_1x\.jpg/, '_1280x.jpg'),
          alt_text: (el as HTMLImageElement).alt || pageTitle || undefined
        }))
          .filter(img => img.sourceUrl && !img.sourceUrl.includes('1x1.jpg')), title // Pass title for alt_text fallback
      );
    }

    // Extract sizes and availability from productJson.variants
    let formattedSizes: Size[] = [];
    let extractedColors = new Set<string>();

    if (productJson?.variants && Array.isArray(productJson.variants)) {
      productJson.variants.forEach((variant: any) => {
        if (variant.option3 && typeof variant.option3 === 'string' && variant.option3.includes('ЗРІСТ')) {
          formattedSizes.push({
            size: variant.option3.trim(),
            is_available: variant.available === true
          });
        } else if (variant.option2 && typeof variant.option2 === 'string' && variant.option2.includes('ЗРІСТ')) {
          // Fallback if option3 is not the size but option2 is
          formattedSizes.push({
            size: variant.option2.trim(),
            is_available: variant.available === true
          });
        }
        // else if (variant.option1 && typeof variant.option1 === 'string' && variant.option1.includes('ЗРІСТ')) {
        // // Fallback if option1 is the size
        //      formattedSizes.push({
        //         size: variant.option1.trim(),
        //         is_available: variant.available === true
        //     });
        // }


        // Consolidate color extraction
        if (variant.option1 && typeof variant.option1 === 'string' && !variant.option1.toLowerCase().includes('size') && !variant.option1.includes('ЗРІСТ')) {
          extractedColors.add(variant.option1.trim());
        }
      });
    }

    // If JSON parsing failed or didn't yield sizes, try old method (less reliable)
    if (formattedSizes.length === 0) {
      log.debug("Sizes not found in product JSON variants, trying DOM selectors as fallback.");
      try {
        const sizeElements = await page.$$(SELECTORS.product.sizesWrapper);
        for (const wrapper of sizeElements) {
          try {
            const legendText = await wrapper.$eval(SELECTORS.product.sizeLegend, el => el.textContent?.trim().toLowerCase());
            // Target "Material" or similar if "Size" gives "one size"
            if (legendText && (legendText.includes('material') || legendText.includes('розмір') || legendText.includes('size'))) {
              const domSizes = await wrapper.$$eval(SELECTORS.product.sizeInputs, els =>
                els.map(el => (el as HTMLInputElement).value.trim())
              );
              // Filter out "one size" explicitly if found via DOM
              domSizes.forEach(s => {
                if (s.toLowerCase() !== 'one size') {
                  formattedSizes.push({ size: s, is_available: true }); // Assume available if found in DOM
                }
              });
              if (formattedSizes.length > 0) break; // Stop if sizes found
            }
          } catch (e) { /* Legend not found or other minor error, continue */ }
        }
      } catch (error) {
        log.error('Fallback DOM size extraction failed:', error);
      }
    }
    // Remove duplicate sizes that might have been added if both JSON and DOM methods ran
    formattedSizes = formattedSizes.filter((size, index, self) =>
      index === self.findIndex((s) => s.size === size.size)
    );


    // Extract description
    let description = productJson?.description?.replace(/<\/?[^>]+(>|$)/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() || '';
    if (!description) {
      description = await page.$$eval(SELECTORS.product.description, els =>
        els.map(el => el.textContent?.trim()).filter(Boolean).join(' ')
      ).catch(() => '');
    }


    // Extract product ID from URL or JSON
    const product_id = productJson?.handle || sourceUrl.split('/').pop()?.split('?')[0] || '';

    // Determine main color
    let color: string | undefined = undefined;
    if (extractedColors.size > 0) {
      color = Array.from(extractedColors)[0]; // Take the first extracted color
    } else if (productJson?.variants?.[0]?.option1 && !productJson.variants[0].option1.toLowerCase().includes('size') && !productJson.variants[0].option1.includes('ЗРІСТ')) {
      color = productJson.variants[0].option1.trim();
    }
    if (!color && title.includes('|')) {
      const titleParts = title.split('|');
      if (titleParts.length > 1) {
        color = titleParts[1].trim();
      }
    }


    const itemData: Omit<Item, 'mushUrl' | 'status'> = {
      sourceUrl,
      product_id,
      title,
      images,
      price,
      currency: 'UAH',
      description,
      sizes: formattedSizes,
      color,
      variants: extractedColors.size > 1 ? Array.from(extractedColors).map(c => ({
        name: c,
        url: null // Assuming variants are color based and on the same page
      })) : undefined
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