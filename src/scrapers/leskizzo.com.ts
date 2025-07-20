import type { Page } from 'playwright';
import type { Item, Size, Image } from '../types/item.js'; // Import needed types
import * as Utils from "../db/db-utils.js";
import type { Scraper } from './types.js';
import { uploadImageUrlToS3 } from '../providers/s3.js'; // Import S3 function
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js'; // Import the new helper
import { logger } from '../utils/logger.js';

export const SELECTORS = {
  productGrid: 'div.products > ul.products__list',
  productLinks: 'ul.products__list > li.products__item a.product__img-wrap',
  product: {
    title: '.page-product__title',
    priceContainer: '.price--inner-page',
    priceCurrent: '.price__current',
    pricePrevious: '.price__previous',
    currencySymbol: '.price__currency',
    productIdContainer: '.js-product-article',
    productIdSelector: '.__number',
    imagesContainer: '.page-product__images',
    imageSlides: '.swiper-slide',
    imageLink: 'a.page-product__img-wrap',
    imageTag: 'img.page-product__img',
    videoTag: 'video.page-product__img source',
    imageSrcAttr: 'src',
    imageDataSrcAttr: 'data-src',
    imageHrefAttr: 'href',
    sizeList: '.sizes__list',
    sizeItems: '.sizes__item',
    sizeInput: 'input[name="size"]',
    sizeText: '.sizes__text',
    sizeAvailableClass: 'sizes__item--enable',
    sizeDataAttr: 'data-size',
    accordionBlocks: '.accordion__block',
    accordionButtonText: '.accordion__button-text',
    accordionContent: '.accordion__content',
    availabilityMessage: '.product-form__dialog-link',
  }
};

/**
 * Gathers item URLs from the current page.
 * @param page Playwright page object
 * @returns A set of product URLs
 */
export async function getItemUrls(page: Page): Promise<Set<string>> {
  const gridSelector = SELECTORS.productGrid;
  const linkSelector = SELECTORS.productLinks;
  // Wait for the container AND at least one link to ensure content is loaded
  try {
    await page.waitForSelector(gridSelector, { timeout: 10000 });
    // Add a small wait for links to potentially render after grid appears
    await page.waitForTimeout(500);
    await page.waitForSelector(linkSelector, { timeout: 10000 }); // Wait for at least one link

    const urls = await page.evaluate((s) => {
      const links = document.querySelectorAll(s.linkSelector);
      // Resolve relative URLs and filter empties
      return Array.from(links, link => (link as HTMLAnchorElement).href).filter(Boolean);
    }, { linkSelector }); // Pass selector correctly as an object

    if (urls.length === 0) {
      const log = logger.createContext('leskizzo.com');
      log.debug(`getItemUrls: Selectors found, but extracted 0 URLs from ${page.url()}.`);
    }
    return new Set(urls as string[]);
  } catch (error) {
    const log = logger.createContext('leskizzo.com');
    log.debug(`getItemUrls: Failed to find grid ("${gridSelector}") or links ("${linkSelector}") on ${page.url()}. Error: ${error}`);
    return new Set<string>();
  }
}

/**
 * Paginates by scrolling down the page to trigger infinite scroll.
 * @param page Playwright page object
 * @returns `true` if more items were likely loaded, `false` otherwise.
 */
export async function paginate(page: Page): Promise<boolean> {
  const initialUrlCount = await page.evaluate((s) => {
    // Ensure the selector targets the links within the product items
    return document.querySelectorAll(s.productLinks).length;
  }, SELECTORS);

  try {
    // Scroll to the bottom to trigger infinite scroll
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    // Wait for new items to load by checking if the count of product links increases.
    // We'll wait up to 10 seconds.
    await page.waitForFunction(
      (args) => {
        const currentCount = document.querySelectorAll(args.selector).length;
        // Return true if count has increased
        return currentCount > args.initialCount;
      },
      { selector: SELECTORS.productLinks, initialCount: initialUrlCount }, // Pass args as an object
      { timeout: 10000 } // Wait for 10 seconds
    );

    const log = logger.createContext('leskizzo.com');
    log.verbose(`Scrolled and loaded more items.`);
    return true; // New items were loaded

  } catch (error) {
    const log = logger.createContext('leskizzo.com');
    // If waitForFunction times out, it throws an error
    if (error instanceof Error && error.message.includes('waitForFunction timed out')) {
      log.verbose(`Scroll timeout or no new items loaded after scroll. Assuming end of results.`);
      return false; // No new items loaded within the timeout
    } else {
      // Log other unexpected errors
      log.debug(`Unexpected error during infinite scroll pagination: ${error instanceof Error ? error.message : String(error)}`);
      return false; // Treat other errors as end of pagination
    }
  }
}

// Helper function outside evaluate for parsing price strings
const parsePrice = (text: string | null | undefined): number | undefined => {
  if (!text) return undefined;
  // Remove spaces, non-breaking spaces, and currency symbols, then parse
  const cleaned = text.replace(/[\s\u00A0₴€$]+/g, '').replace(',', '.');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? undefined : parsed;
};

// Helper to resolve relative URLs
const resolveUrl = (baseUrl: string, relativeUrl: string | null | undefined): string | null => {
  if (!relativeUrl) return null;
  try {
    return new URL(relativeUrl, baseUrl).toString();
  } catch (e) {
    const log = logger.createContext('leskizzo.com');
    log.debug(`Invalid URL found: ${relativeUrl}`);
    return null;
  }
};

export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  const sourceUrl = page.url();
  try {
    // Page is already at sourceUrl, ensure content is loaded.
    await page.waitForSelector(SELECTORS.product.title, { timeout: 10000 });

    const rawData = await page.evaluate((s) => {
      // --- Direct DOM Access Only --- 

      const titleElement = document.querySelector(s.product.title);
      const titleText = titleElement?.textContent?.trim() || null;

      // Define explicit type for image data within evaluate
      type RawImageData = { src: string | null, alt: string | null, type: 'image' | 'video' };
      // Price extraction
      const priceContainer = document.querySelector(s.product.priceContainer);
      const priceElement = priceContainer?.querySelector(s.product.priceCurrent);
      const priceText = priceElement?.textContent?.trim() || null;
      const previousPriceElement = priceContainer?.querySelector(s.product.pricePrevious);
      const previousPriceText = previousPriceElement?.textContent?.trim() || null;
      const currencyElement = priceContainer?.querySelector(s.product.currencySymbol);
      const currencySymbolText = currencyElement?.textContent?.trim() || null;
      // Determine if on sale by checking if previousPriceElement exists
      const isOnSale = !!previousPriceElement;

      // Assign prices based on sale status
      const salePriceText = isOnSale ? priceText : null;
      const regularPriceText = isOnSale ? previousPriceText : priceText;

      // Product ID (Article)
      const productIdContainer = document.querySelector(s.product.productIdContainer);
      const productIdElement = productIdContainer?.querySelector(s.product.productIdSelector);
      const productIdText = productIdElement?.textContent?.trim() || null;

      // Images & Videos
      const imageElements = Array.from(document.querySelectorAll(`${s.product.imagesContainer} ${s.product.imageSlides}`));
      const imagesData: RawImageData[] = imageElements.map((slide): RawImageData => {
        const img = slide.querySelector(s.product.imageTag);
        const vidSource = slide.querySelector(s.product.videoTag);
        const link = slide.querySelector(s.product.imageLink);

        if (vidSource) {
          return { src: vidSource.getAttribute('src'), alt: 'Product video', type: 'video' };
        } else if (img) {
          const potentialSrc = link?.getAttribute(s.product.imageHrefAttr) || img.getAttribute(s.product.imageDataSrcAttr) || img.getAttribute(s.product.imageSrcAttr);
          return { src: potentialSrc, alt: img.getAttribute('alt'), type: 'image' };
        }
        return { src: null, alt: null, type: 'image' }; // Explicit type
      }).filter(img => img.src); // Filter out slides without a valid src

      // Sizes
      const sizeElements = Array.from(document.querySelectorAll(`${s.product.sizeList} ${s.product.sizeItems}`));
      const sizeData = sizeElements.map(el => {
        const isAvailable = el.classList.contains(s.product.sizeAvailableClass); // Check for the exact class name
        const sizeTextElement = el.querySelector(s.product.sizeText);
        const sizeText = el.getAttribute(s.product.sizeDataAttr) || sizeTextElement?.textContent?.trim();
        // const input = el.querySelector(s.product.sizeInput);
        // const value = input?.value; // Could use this if needed
        return {
          size: sizeText || '',
          is_available: isAvailable
        };
      }).filter(size => size.size);

      // Description and Composition
      let descriptionText: string | null = null;
      let compositionText: string | null = null;
      const accordionBlocks = document.querySelectorAll(s.product.accordionBlocks);

      accordionBlocks.forEach(block => {
        const buttonTextElement = block.querySelector(s.product.accordionButtonText);
        const contentElement = block.querySelector(s.product.accordionContent);
        const buttonText = buttonTextElement?.textContent?.trim();
        const content = contentElement?.textContent?.trim() || null;

        if (buttonText === 'Опис') {
          descriptionText = content;
        } else if (buttonText === 'Склад і догляд') {
          compositionText = content;
        }
      });

      // Availability Message (e.g., "Очікується")
      const availabilityElement = document.querySelector(s.product.availabilityMessage);
      const availabilityText = availabilityElement?.textContent?.trim() || null;

      // Tags (Not found in DOM)
      const tagTexts: string[] = [];

      return {
        sourceUrl: window.location.href,
        baseUrl: window.location.origin,
        title: titleText,
        description: descriptionText,
        composition: compositionText,
        availabilityText: availabilityText,
        isOnSale: isOnSale,
        regularPriceText: regularPriceText,
        salePriceText: salePriceText,
        fullPriceText: priceText,
        currencySymbolText: currencySymbolText,
        productId: productIdText,
        images: imagesData,
        sizes: sizeData,
        tagTexts: tagTexts,
      };
    }, SELECTORS);

    let product_id = rawData.productId || '';
    if (!product_id) {
      const pathParts = new URL(rawData.sourceUrl).pathname.split('/').filter(Boolean);
      product_id = `leskizzo-${pathParts[pathParts.length - 1] || Date.now()}`;
      const log = logger.createContext('leskizzo.com');
      log.debug(`Could not find product article for ${rawData.sourceUrl}, using fallback ID: ${product_id}`);
    } else {
      product_id = `leskizzo-${product_id}`;
    }

    const title = rawData.title || 'Unknown Product';

    const description = [rawData.description, rawData.composition].filter(Boolean).join('\n\n---\n\n').trim();

    let price: number | undefined;
    let sale_price: number | undefined;

    if (rawData.isOnSale) {
      price = parsePrice(rawData.regularPriceText);
      sale_price = parsePrice(rawData.salePriceText);
    } else {
      price = parsePrice(rawData.regularPriceText); // regularPriceText holds the only price
      sale_price = undefined;
    }

    // Ensure price has a fallback value if parsing failed
    price = price ?? 0;

    let currency = 'UAH'; // Default, based on '₴'
    const currencySymbol = rawData.currencySymbolText;
    if (currencySymbol === '€') currency = 'EUR';
    else if (currencySymbol === '$') currency = 'USD';
    else if (currencySymbol === '₴') currency = 'UAH';

    // Process Images
    const processedImages = rawData.images
      .filter(imgData => imgData.type === 'image' && imgData.src) // Only process images with a source
      .map(imgData => {
        // Resolve URL first
        const resolvedUrl = resolveUrl(rawData.baseUrl, imgData.src);
        return {
          sourceUrl: resolvedUrl,
          alt_text: imgData.alt || title // Use title as fallback alt text
        };
      })
      .filter((img): img is { sourceUrl: string; alt_text: string } => // Type guard: ensure URL is non-null string
        img.sourceUrl !== null &&
        !img.sourceUrl.startsWith('data:') // Filter out base64
      );

    // Filter duplicates after ensuring URL is valid
    const uniqueImagesWithoutMushUrl: Image[] = [];
    const seenUrls = new Set<string>();
    for (const img of processedImages) {
      if (!seenUrls.has(img.sourceUrl)) {
        uniqueImagesWithoutMushUrl.push(img);
        seenUrls.add(img.sourceUrl);
      }
    }

    // --- Use the helper function for S3 Upload Logic --- 
    // Image handling with existing images support
    let imagesWithMushUrl: Image[];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
      const log = logger.createContext('leskizzo.com');
      log.verbose(`Using ${options.existingImages.length} existing images from database`);
      imagesWithMushUrl = options.existingImages.map(img => ({
        sourceUrl: img.sourceUrl,
        mushUrl: img.mushUrl,
        alt_text: undefined
      }));
    } else {
      if (options?.uploadToS3 !== false) {

        imagesWithMushUrl = await uploadImagesToS3AndAddUrls(uniqueImagesWithoutMushUrl, rawData.sourceUrl);

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        imagesWithMushUrl = uniqueImagesWithoutMushUrl;

      }
    }
    // --- End S3 Upload Logic ---

    const videoUrl = rawData.images.find(img => img.type === 'video')?.src;
    const resolvedVideoUrl = videoUrl ? resolveUrl(rawData.baseUrl, videoUrl) : undefined;

    const sizes: Size[] = rawData.sizes.map(s => ({
      size: s.size,
      is_available: s.is_available
    }));

    const isAvailableOverall = sizes.length > 0
      ? sizes.some(s => s.is_available)
      : rawData.availabilityText !== 'Очікується';

    const tags = rawData.tagTexts;
    const vendor = 'leskizzo';

    const itemData: Item = {
      sourceUrl: rawData.sourceUrl,
      product_id,
      title,
      description: description || undefined,
      vendor,
      images: imagesWithMushUrl,
      price: price,
      sale_price: sale_price,
      currency,
      sizes: sizes.length > 0 ? sizes : undefined,
      tags: tags.length > 0 ? tags : undefined,
      status: isAvailableOverall ? 'ACTIVE' : undefined,
    };

    return Utils.formatItem(itemData);

  } catch (error) {
    const log = logger.createContext('leskizzo.com');
    log.error(`Error scraping ${sourceUrl}: ${error}`);
    throw new Error(`Failed to scrape item at ${sourceUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper;