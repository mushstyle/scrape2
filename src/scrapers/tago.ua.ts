import { /* chromium, Browser, */ Page } from 'playwright';
import { Item, Image, Size } from '../types/item.js';
import * as Utils from '../db/db-utils.js';
import { uploadImageUrlToS3 } from '../providers/s3.js';
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../lib/logger.js';

const log = logger.createContext('tago.ua');

export const SELECTORS = {
  productGrid: '.grid-wrapper.row-flex',
  productLinks: '.product a',
  pagination: {
    type: 'numbered',
    nextButton: '.pagination__ul li.next:not(.disabled) a',
    pattern: 'page={n}'
  },
  product: {
    container: '.product',
    title: '.name',
    price: {
      current: '.new-price',
      old: '.old-price'
    },
    images: {
      container: '.foto img',
      mainImage: '.first-img',
      secondaryImage: '.second-img',
      sourceUrl: 'src',
      alt: 'alt'
    },
    productId: {
      attribute: 'data-id',
      selector: '.product a'
    },
    color: {
      attribute: 'data-color',
      selector: '.product a'
    },
    category: {
      attribute: 'data-category',
      selector: '.product a'
    }
  },
  filters: {
    size: {
      container: ".filter-section:has(h3:contains('The size')) .filter-options li",
      label: 'label',
      count: '.selection__option-count'
    },
    color: {
      container: ".filter-section:has(h3:contains('Colour')) .filter-options li",
      label: 'label',
      count: '.selection__option-count'
    }
  }
};

export async function getItemUrls(page: Page): Promise<Set<string>> {
  await Promise.race([
    page.waitForSelector(SELECTORS.productGrid, { timeout: 10000 }),
    page.waitForSelector(SELECTORS.productLinks, { timeout: 10000 })
  ]);

  const urls = await page.evaluate((selector) => {
    const links = document.querySelectorAll(selector);
    return [...new Set([...links].map(a => (a as HTMLAnchorElement).href))];
  }, SELECTORS.productLinks);

  return new Set(urls);
}

export async function paginate(page: Page): Promise<boolean> {
  let nextUrl: string = page.url(); // Initialize with current URL as fallback
  try {
    // Build next page URL
    const currentUrl = page.url();
    if (currentUrl.includes('/page/')) {
      const currentPage = parseInt(currentUrl.match(/\/page\/(\d+)/)?.[1] || '1');
      nextUrl = currentUrl.replace(`/page/${currentPage}`, `/page/${currentPage + 1}`);
    } else {
      // Ensure base URL doesn't end with a slash before appending /page/2
      const base = currentUrl.split('?')[0].replace(/\/$/, '');
      const query = currentUrl.split('?')[1];
      nextUrl = `${base}/page/2${query ? '?' + query : ''}`;
    }

    const response = await page.goto(nextUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 10000 // Increased timeout
    });

    if (!response || !response.ok()) {
      log.normal(`   Pagination failed: Non-OK response for ${nextUrl} (status: ${response?.status()})`);
      return false; // Stop if navigation fails
    }

    // Basic check: Did we land on a page with a product grid?
    // A more robust check might involve seeing if product *links* are present
    await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000, state: 'visible' });
    log.normal(`   Successfully navigated to next page: ${nextUrl}`);
    return true; // Navigation succeeded, page seems valid

  } catch (error) {
    // Check if the error is a timeout waiting for the product grid, which indicates no more items
    if (error instanceof Error && error.message.includes('Timeout') && error.message.includes(SELECTORS.productGrid)) {
      log.normal(`   Pagination likely ended: Product grid selector (${SELECTORS.productGrid}) not found on ${nextUrl}`);
    } else {
      // Log other errors (e.g., navigation errors)
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.normal(`   Pagination failed for ${nextUrl}: ${errorMessage}`);
    }
    return false; // Indicate failure
  }
}

export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  const sourceUrl = page.url();
  try {
    // Page is already at sourceUrl, ensure content is loaded.
    await page.waitForSelector('.product-info h1.name', { timeout: 10000 });

    // Define intermediate type
    type ScrapedData = Omit<Item, 'mushUrl' | 'status'> & {
      images: Image[];
      sizes: Size[];
    };

    const itemData = await page.evaluate((sourceUrl) => {
      const title = document.querySelector('.product-info h1.name')?.textContent?.trim() || '';
      const vendorCode = document.querySelector('.price-article .article')?.textContent?.trim()?.replace('vendor code', '').trim() || '';
      const descriptionElements = Array.from(document.querySelectorAll('.product-description p'));
      const description = descriptionElements.slice(1).map(p => p.textContent?.trim()).filter(Boolean).join('\n');

      let price = 0;
      let salePrice: number | undefined;
      let currency = 'EUR'; // Default, Tago seems to use EUR on the /en/ site though
      const priceEl = document.querySelector('.price-article .price');
      if (priceEl) {
        const priceText = priceEl.textContent || '';
        price = parseFloat(priceText.replace(/[^\d.]/g, '') || '0');
        const currencyMatch = priceText.match(/[a-zA-Z]+/);
        currency = currencyMatch ? currencyMatch[0] : 'EUR';
      }

      const images: Image[] = [];
      // Select all non-cloned carousel items
      const imageItems = document.querySelectorAll('.product-gallery .owl-item:not(.cloned)');

      imageItems.forEach(item => {
        const linkEl = item.querySelector('figure.easyzoom a') as HTMLAnchorElement | null;
        const imgEl = item.querySelector('figure.easyzoom img') as HTMLImageElement | null;

        let imageUrl: string | null = null;
        // Prioritize the link's href
        if (linkEl && linkEl.href) {
          imageUrl = linkEl.href;
        } else if (imgEl && imgEl.src) {
          // Fallback to image src
          imageUrl = imgEl.src;
        }

        if (imageUrl) {
          // Avoid adding duplicate URLs
          if (!images.some(img => img.sourceUrl === imageUrl)) {
            images.push({
              sourceUrl: imageUrl,
              alt_text: imgEl?.alt || title
            });
          }
        }
      });

      const sizeOptions = Array.from(document.querySelectorAll('#groupSizes option'));
      const sizes: Size[] = sizeOptions
        .map(el => {
          const option = el as HTMLOptionElement;
          if (!option.value) return null;
          return {
            size: option.textContent?.trim() || option.value || '',
            is_available: true // Assuming all listed sizes are available; no disabled attribute seen
          };
        })
        .filter((s): s is Size => s !== null && s.size !== '');

      const isAvailable = sizes.length > 0;
      const product_status = isAvailable ? 'ACTIVE' : 'DELETED';

      return {
        sourceUrl,
        product_id: vendorCode,
        title,
        description,
        vendor: 'tago',
        images: images.filter(img => img.sourceUrl),
        price,
        sale_price: salePrice,
        currency,
        sizes,
        tags: [],
      };
    }, sourceUrl);

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

    const finalItem: Item = {
      ...itemData,
      images: imagesWithMushUrl,
      status: 'ACTIVE'
    };

    return Utils.formatItem(finalItem);

  } catch (error) {
    log.error('Error scraping item:', error);
    throw error;
  }
}