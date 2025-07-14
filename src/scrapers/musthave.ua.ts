import type { Page } from 'playwright';
import { Item, Image, Size } from '../types/item.js';
import * as Utils from "../db/db-utils.js";
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../lib/logger.js';

const log = logger.createContext('musthave.ua');

export const SELECTORS = {
  productGrid: '.category__products',
  productLinks: '.product',
  pagination: {
    type: 'numbered' as const,
    pattern: 'page={n}'
  },
  product: {
    title: '.product__title',
    price: '.product__prices .price__value',
    images: '.product__images img',
    currency: '.price__currency',
    description: '.product__description',
    sizes: '.product__sizes button:not(.disabled)',
    tags: '.product__categories a'
  }
};

/**
 * Gathers item URLs on the current page
 */
export async function getItemUrls(page: Page): Promise<Set<string>> {
  // Wait for at least one product to be visible
  await page.waitForSelector(SELECTORS.productLinks, {
    timeout: 10000,
    state: 'visible'
  });

  // Get all product URLs
  const links = await page.$$eval(SELECTORS.productLinks, products => {
    return [...new Set(
      products.map(product => {
        const link = product.querySelector('a[href*="/product/"]');
        return link ? (link as HTMLAnchorElement).href : '';
      }).filter(url => url !== '') // Filter out empty strings
    )] as string[];
  });

  return new Set(links);
}

/**
 * Paginates by incrementing the page number in the URL
 */
export async function paginate(page: Page): Promise<boolean> {
  const currentUrl = page.url();
  const match = currentUrl.match(/page=(\d+)/);
  const currentPage = match ? parseInt(match[1], 10) : 1;
  const nextPage = currentPage + 1;

  // Check if we've reached the last page by looking at the hidden lastPageId div
  try {
    const lastPageId = await page.$eval('#lasPageId', el => parseInt(el.textContent?.trim() || '0', 10));
    if (lastPageId > 0 && currentPage >= lastPageId) {
      log.debug(`   Reached last page (${currentPage} of ${lastPageId})`);
      return false;
    }
  } catch (e) {
    // If we can't find lastPageId, continue with normal pagination logic
  }

  // Build next page URL
  let nextUrl = currentUrl;
  if (match) {
    nextUrl = currentUrl.replace(/page=\d+/, `page=${nextPage}`);
  } else {
    const separator = currentUrl.includes('?') ? '&' : '?';
    nextUrl = `${currentUrl}${separator}page=${nextPage}`;
  }

  try {
    const response = await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    if (!response || !response.ok()) {
      log.debug(`   Pagination failed: Non-OK response for ${nextUrl} (status: ${response?.status()})`);
      return false;
    }
    // Add a check to see if the product grid is still present after navigation
    await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000, state: 'visible' });
    log.debug(`   Successfully navigated to next page: ${nextUrl}`);
    return true; // Navigation succeeded, potentially more items
  } catch (error) {
    // Check if the error is a timeout waiting for the product grid, which indicates no more items
    if (error instanceof Error && error.message.includes('Timeout') && error.message.includes(SELECTORS.productGrid)) {
      log.debug(`   Pagination likely ended: Product grid selector (${SELECTORS.productGrid}) not found on ${nextUrl}`);
    } else {
      // Log other errors (e.g., navigation errors)
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.debug(`   Pagination failed for ${nextUrl}: ${errorMessage}`);
    }
    return false; // Navigation or content check failed
  }
}

/**
 * Scrapes item details from the provided URL
 */
export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  const sourceUrl = page.url();
  try {
    // Page is already at sourceUrl, ensure content is loaded.
    await page.waitForSelector('.product-new__wrapper', { timeout: 10000 });

    // Define intermediate type based on evaluate return
    type ScrapedData = Omit<Item, 'images' | 'status'> & {
      images: Omit<Image, 'mushUrl'>[];
      variants?: { name: string; url: string | null }[]; // Add variants if returned
    };

    const itemData: ScrapedData = await page.evaluate(() => {
      const wrapper = document.querySelector('.product-new__wrapper');
      if (!wrapper) throw new Error('Product wrapper not found');

      const title = wrapper.querySelector('.product-new__name')?.textContent?.trim() || '';
      const productId = wrapper.querySelector('.product-new__code span')?.textContent?.trim() || '';
      const priceText = wrapper.querySelector('.product-new__price-value')?.textContent?.trim() || '0';
      const price = parseFloat(priceText.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
      const currency = wrapper.querySelector('.product-new__price-currency')?.textContent?.trim() || 'UAH';

      // Intermediate image type
      type IntermediateImage = { sourceUrl: string; alt_text: string };

      const images: IntermediateImage[] = Array.from(wrapper.querySelectorAll('.product-new__main-slider-image'))
        .map(link => {
          const img = link.querySelector('img');
          const imgUrl = link.getAttribute('href') || '';
          return {
            sourceUrl: imgUrl.startsWith('//') ? 'https:' + imgUrl : imgUrl, // Ensure absolute URL
            alt_text: img?.getAttribute('alt') || ''
          };
        })
        .filter((img): img is IntermediateImage => {
          return typeof img.sourceUrl === 'string' && img.sourceUrl.length > 0 && !img.sourceUrl.includes('svg');
        }
        )
        .filter((img, index, self) => self.findIndex(t => t.sourceUrl === img.sourceUrl) === index);

      const sizes: Size[] = Array.from(wrapper.querySelectorAll('.product-new__sizes li'))
        .map(li => ({
          size: li.getAttribute('data-size') || '',
          is_available: !!(li.getAttribute('data-preorder') === '0')
        }))
        .filter(size => size.size);

      const description = wrapper.querySelector('.product-new__description')?.textContent?.trim() || '';

      const variants = Array.from(wrapper.querySelectorAll('.product-new__colors li'))
        .map(li => {
          const link = li.querySelector('a');
          return {
            name: link?.getAttribute('title')?.trim() || '',
            url: link?.getAttribute('href') || null
          };
        })
        .filter(variant => variant.name && variant.url);

      // Return object matching ScrapedData
      return {
        sourceUrl: window.location.href,
        product_id: productId,
        title,
        description,
        images, // Matches Omit<Image, 'mushUrl'>[]
        price,
        currency,
        sizes,
        variants,
        vendor: 'musthave',
        tags: [], // Add missing fields
        type: undefined
      };
    });

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

    // Construct final Item
    const finalItem: Item = {
      ...itemData,
      images: imagesWithMushUrl,
      status: 'ACTIVE' // Assuming active if scraped
    };

    return Utils.formatItem(finalItem);

  } catch (error) {
    log.error('Error scraping item:', error);
    // Return minimal error item matching Item type
    return Utils.formatItem({
      sourceUrl: sourceUrl,
      product_id: '',
      title: `Error scraping item`,
      description: error instanceof Error ? error.message : String(error),
      status: undefined,
      vendor: 'musthave',
      price: 0,
      currency: 'XXX',
      images: [],
      sizes: [],
      color: undefined,
      tags: [],
      type: undefined,
    });
  }
}

// Define Scraper object after scrapeItem function
const scraper: Scraper = {
  getItemUrls,
  paginate,
  scrapeItem
};

export default scraper;