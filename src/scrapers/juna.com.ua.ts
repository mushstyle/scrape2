import type { Page } from 'playwright';
import type { Item, Image, Size } from '../types/item.js'; // Import Item types
import * as Utils from '../db/db-utils.js';
import { uploadImageUrlToS3 } from '../providers/s3.js'; // Import S3 function
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js'; // Import the new helper
import type { Scraper } from './types.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('juna.com.ua');

/**
 * Scraper for juna.com.ua using page number pagination.
 */

export const SELECTORS = {
  // Product listing page selectors
  productGrid: '.section__products__list__2items', // Container for product cards
  productLinks: '.product__card a.product__card__title', // Links to individual products within cards
  pagination: {
    type: 'numbered' as const,
    pattern: 'page={n}' // Query parameter for page number
  },
  // Individual product page selectors
  product: {
    container: '.section__product__content',
    title: 'h1.section__product__title',
    price: '.section__product__price', // Contains the price like "7100.00₴"
    images: '.section__product__main__slide img', // Main product images in the slider
    thumbImages: '.section__product__thumb__slide img', // Thumbnail images
    description: '.section__product__description p', // Initial short description
    productIdContainer: '.section__product__left', // Container holding data-productid
    productIdAttribute: 'data-productid',
    wishlistButton: '.section__product__wish', // Contains onclick="wishlist.toggle('ID')"
    colorOptionsContainer: '.section__product__options__content',
    colorOptionInput: 'input[type="radio"][name^="option"]', // Radio buttons for color variants
    colorOptionLabel: 'label.product__card__color', // Labels associated with color inputs
    infoTabsContainer: '.section__product__info__content',
    infoTabContent: '.section__product__info__content__text', // Divs containing description, material, care, delivery
    infoTabButtons: '.section__product__info__btn', // Buttons to switch info tabs
    status: '.section__product__status span', // Text indicating availability status like "Під замовлення"
  }
};

/**
 * Gathers item URLs on the current page.
 * @param page Playwright page object.
 * @returns A set of product URLs.
 */
export async function getItemUrls(page: Page): Promise<Set<string>> {
  // Wait for grid and product links – if not found treat as empty set
  try {
    await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000 });
    await page.waitForSelector(SELECTORS.productLinks, { timeout: 10000 });
  } catch (_) {
    return new Set();
  }

  const links = await page.$$eval(SELECTORS.productLinks, els => els.map(e => (e as HTMLAnchorElement).href));
  return new Set(links);
}

/**
 * Paginates by incrementing the page number query parameter in the URL.
 * @param page Playwright page object.
 * @returns An array of newly discovered URLs on this page.
 * @throws When pagination is complete (no new products found or error).
 */
export async function paginate(page: Page): Promise<boolean> {
  // Ensure current page loaded
  try {
    await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000 });
  } catch (_) {
    return false;
  }

  // Build next url
  const currentUrl = new URL(page.url());
  const pageParam = currentUrl.searchParams.get('page');
  const currentNum = pageParam ? parseInt(pageParam, 10) : 1;
  currentUrl.searchParams.set('page', String(currentNum + 1));
  const nextUrl = currentUrl.toString();

  try {
    const response = await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    if (!response || !response.ok()) {
      return false;
    }

    const urls = await getItemUrls(page);
    return urls.size > 0;
  } catch (_) {
    return false;
  }
}

// -----------------------
// Default export (Scraper)
// -----------------------

const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper;

/**
 * Scrapes item details from the provided product URL.
 * @param url The product URL.
 * @returns A structured Item object.
 */
export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  const sourceUrl = page.url();
  try {
    // Page is already at sourceUrl, ensure content is loaded.
    await page.waitForSelector(SELECTORS.product.container, { timeout: 10000 });

    // Define an intermediate type for evaluated data
    type ScrapedData = Omit<Item, 'mushUrl' | 'status'> & {
      images: Image[];
      sizes: Size[];
      variants: { name: string; url: string | null }[];
    };

    const itemData = await page.evaluate((SELECTORS): ScrapedData => {
      const container = document.querySelector(SELECTORS.product.container);
      if (!container) throw new Error('Product container not found');

      // --- Basic Info ---
      const title = container.querySelector(SELECTORS.product.title)?.textContent?.trim() || '';
      let productId = '';
      const productIdContainer = container.querySelector(SELECTORS.product.productIdContainer);
      if (productIdContainer) {
        productId = productIdContainer.getAttribute(SELECTORS.product.productIdAttribute) || '';
      }
      if (!productId) {
        const wishlistButton = container.querySelector(SELECTORS.product.wishlistButton);
        const onclickAttr = wishlistButton?.getAttribute('onclick');
        const match = onclickAttr?.match(/wishlist\.toggle\('(\d+)'\)/);
        if (match && match[1]) {
          productId = match[1];
        }
      }
      const vendor = 'Juna'; // Assuming vendor based on domain

      // --- Price & Currency ---
      let price = 0;
      let salePrice: number | undefined;
      let currency = 'UAH';
      const priceElement = container.querySelector(SELECTORS.product.price);
      if (priceElement) {
        const priceText = priceElement.textContent?.trim() || '0';
        currency = priceText.match(/[^\d.,\s]/)?.[0] || '₴';
        price = parseFloat(priceText.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
      }

      // --- Images ---
      let images: Image[] = [];
      const mainImageElements = Array.from(container.querySelectorAll(SELECTORS.product.images));
      images = mainImageElements.map(img => ({
        sourceUrl: (img as HTMLImageElement).src || '',
        alt_text: (img as HTMLImageElement).alt || title || '',
      })).filter(img => img.sourceUrl && !img.sourceUrl.includes('placeholder'));

      // If main slider images are insufficient, try thumbnails
      if (images.length < 2) {
        const thumbImageElements = Array.from(container.querySelectorAll(SELECTORS.product.thumbImages));
        const thumbImages = thumbImageElements.map(img => ({
          sourceUrl: (img as HTMLImageElement).src || '',
          alt_text: (img as HTMLImageElement).alt || title || '',
        })).filter(img => img.sourceUrl && !img.sourceUrl.includes('placeholder'));

        // Combine and deduplicate
        const combinedImages = [...images, ...thumbImages];
        images = combinedImages.filter((img, index, self) =>
          index === self.findIndex((t) => t.sourceUrl === img.sourceUrl)
        );
      }

      // --- Description (Combine Tabs) ---
      let descriptionParts: string[] = [];
      const shortDescription = container.querySelector(SELECTORS.product.description)?.textContent?.trim();
      if (shortDescription) {
        descriptionParts.push(shortDescription);
      }
      const infoTabElements = Array.from(container.querySelectorAll(SELECTORS.product.infoTabContent));
      infoTabElements.forEach(tab => {
        const tabText = tab.textContent?.trim();
        if (tabText && !descriptionParts.includes(tabText)) {
          descriptionParts.push(tabText);
        }
      });
      const description = descriptionParts.join('\n\n');

      // --- Color Variants ---
      const colorOptionContainer = container.querySelector(SELECTORS.product.colorOptionsContainer);
      let variants: { name: string, url: string | null }[] = [];
      let primaryColor = '';
      if (colorOptionContainer) {
        const colorInputs = Array.from(colorOptionContainer.querySelectorAll(SELECTORS.product.colorOptionInput));
        colorInputs.forEach(input => {
          const radioInput = input as HTMLInputElement;
          const label = colorOptionContainer.querySelector(`label[for="${radioInput.id}"]`);
          const colorName = label?.getAttribute('data-original-title') || radioInput.value || 'Unknown Color';
          const variantUrl = radioInput.getAttribute('data-link');

          if (colorName) {
            variants.push({ name: colorName, url: variantUrl });
            if (radioInput.checked) {
              primaryColor = colorName;
            }
          }
        });
        if (!primaryColor && variants.length > 0) {
          primaryColor = variants[0].name;
        }
      }

      // --- Sizes ---
      const sizes: Size[] = [];

      // --- Type/Category --- (Removed breadcrumb logic)
      const type = undefined;

      return {
        sourceUrl: window.location.href,
        product_id: productId,
        title,
        description,
        vendor,
        type,
        images,
        price,
        sale_price: salePrice,
        currency: currency === '₴' ? 'UAH' : currency,
        sizes,
        variants,
        color: primaryColor || undefined,
        tags: []
      };
    }, SELECTORS);

    // --- Use the helper function for S3 Upload Logic --- 
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
      images: imagesWithMushUrl,
      status: 'ACTIVE'
    };

    return Utils.formatItem(finalItem);

  } catch (error) {
    log.error(`Error scraping item ${sourceUrl}:`, error);
    throw error;
  }
}