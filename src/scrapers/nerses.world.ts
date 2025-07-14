import type { Page } from 'playwright';
import { Item, Image, Size } from '../types/item.js';
import * as Utils from "../db/db-utils.js";
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../lib/logger.js';

const log = logger.createContext('nerses.world');

export const SELECTORS = {
  productGrid: '#facets-results',
  productLinks: 'a[data-preorder-handle]',
  pagination: {
    type: 'numbered' as const,
    pattern: 'page={n}'
  },
  product: {
    title: '.product-title',
    price: '[data-product-price]', // Use attribute for more reliable price fetching
    salePrice: '.text-scheme-accent .money', // Price when on sale
    comparePrice: '.text-scheme-meta .money', // Original price when on sale
    productId: 'input[name="product-id"]',
    // Primary strategy: target the JSON script containing image data
    productImagesJson: 'script[data-product-images]',
    // Fallback strategy: target images within the main slider
    productImagesSlider: '.splide__slide img.responsive-image',
    sizes: 'input[name="options[Size]"]',
    description: '.smart-tabs-wrapper .smart-tabs-untabbed-content', // Content within smart tabs
    availability: '.variant-input label.line-through', // Indicates sold-out size
    vendor: 'nerses' // Static vendor name
  }
};

export async function getItemUrls(page: Page): Promise<Set<string>> {
  await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000 });
  const urls = await page.evaluate((s) => {
    const links = document.querySelectorAll(s.productLinks);
    // Ensure href is absolute
    return Array.from(links, link => new URL((link as HTMLAnchorElement).href, document.baseURI).href);
  }, SELECTORS);
  return new Set(urls);
}

export async function paginate(page: Page): Promise<boolean> {
  // Get current page number from URL
  const currentUrl = page.url();
  const pageMatch = currentUrl.match(/[?&]page=(\d+)/);
  const currentPage = pageMatch ? parseInt(pageMatch[1], 10) : 1;
  const nextPage = currentPage + 1;

  // Construct next page URL
  let nextUrl = currentUrl;
  if (pageMatch) {
    nextUrl = nextUrl.replace(/([?&]page=)\d+/, `$1${nextPage}`);
  } else {
    nextUrl += (nextUrl.includes('?') ? '&' : '?') + `page=${nextPage}`;
  }

  // Try loading next page and check content
  try {
    // Increase timeout slightly for navigation
    const response = await page.goto(nextUrl, {
      waitUntil: 'domcontentloaded', // Use domcontentloaded for faster initial load
      timeout: 10000
    });

    if (!response || !response.ok()) {
      log.debug(`   Pagination failed: Non-OK response for ${nextUrl} (status: ${response?.status()})`);
      return false; // Stop if navigation fails
    }

    // Wait for the product grid to ensure the page loaded correctly with items
    await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000, state: 'visible' });
    log.debug(`   Successfully navigated to next page: ${nextUrl}`);
    return true; // Navigation and content check succeeded

  } catch (error) {
    // Check if the error is a timeout waiting for the product grid, which indicates no more items
    if (error instanceof Error && error.message.includes('Timeout') && error.message.includes(SELECTORS.productGrid)) {
      log.debug(`   Pagination likely ended: Product grid selector (${SELECTORS.productGrid}) not found on ${nextUrl}`);
    } else {
      // Log other errors (e.g., navigation errors)
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.debug(`   Pagination failed for ${nextUrl}: ${errorMessage}`);
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
    await page.waitForLoadState('networkidle'); // Retain this if important for the site
    await page.waitForSelector(SELECTORS.product.title, { timeout: 10000 });

    // Define intermediate type based on evaluate return
    type ScrapedData = Omit<Item, 'images' | 'status'> & {
      images: Omit<Image, 'mushUrl'>[];
      product_status?: string;
      currency: string; // Currency is definitely returned
      // Price and sale_price will be numbers here
    };

    const itemData: ScrapedData = await page.evaluate((s) => {
      const title = document.querySelector(s.product.title)?.textContent?.trim() || '';
      const priceAttr = document.querySelector(s.product.price)?.getAttribute('content');
      const priceText = document.querySelector(s.product.price)?.textContent?.trim() || '';
      const price = priceAttr || priceText.replace(/[^0-9.,]/g, '');
      const salePriceText = document.querySelector(s.product.salePrice)?.textContent?.trim();
      const comparePriceText = document.querySelector(s.product.comparePrice)?.textContent?.trim();

      let finalPriceStr = price;
      let finalSalePriceStr: string | undefined = undefined;
      if (salePriceText && comparePriceText) {
        finalPriceStr = comparePriceText.replace(/[^0-9.,]/g, '');
        finalSalePriceStr = salePriceText.replace(/[^0-9.,]/g, '');
      } else if (salePriceText && !comparePriceText) {
        finalPriceStr = salePriceText.replace(/[^0-9.,]/g, '');
        finalSalePriceStr = finalPriceStr;
      } else {
        finalPriceStr = price;
      }

      // Parse prices to numbers within evaluate
      const numericPrice = parseFloat(String(finalPriceStr || '0').replace(/,/g, '.')) || 0;
      const numericSalePrice = finalSalePriceStr ? parseFloat(String(finalSalePriceStr).replace(/,/g, '.')) : undefined;

      const description = document.querySelector(s.product.description)?.textContent?.trim() || '';
      const product_id = document.querySelector(s.product.productId)?.getAttribute('value') || '';

      type IntermediateImage = { sourceUrl: string; alt_text: string }; // alt_text is now required string
      let images: IntermediateImage[] = [];
      try {
        const productImagesJsonScript = document.querySelector(s.product.productImagesJson);
        if (productImagesJsonScript && productImagesJsonScript.textContent) {
          const imageData = JSON.parse(productImagesJsonScript.textContent);
          if (Array.isArray(imageData)) {
            images = imageData.map(imgData => ({
              sourceUrl: imgData.fullSizeUrl.startsWith('//') ? `https:${imgData.fullSizeUrl}` : imgData.fullSizeUrl,
              alt_text: title || 'Product Image'
            }));
          }
        }
      } catch (e) { log.error("Failed to parse product image JSON:", e); images = []; }

      if (images.length === 0) {
        log.debug("Falling back to extracting images from slider elements");
        images = Array.from(document.querySelectorAll(s.product.productImagesSlider))
          .map(img => {
            const imgEl = img as HTMLImageElement;
            const srcset = imgEl.getAttribute('data-srcset') || imgEl.getAttribute('srcset');
            let imageUrl = imgEl.src;
            if (srcset) {
              const sources = srcset.split(',').map(part => {
                const [url, widthDesc] = part.trim().split(' ');
                const absoluteUrl = url.startsWith('//') ? `https:${url}` : url;
                return { sourceUrl: absoluteUrl, width: parseInt(widthDesc) || 0 };
              }).sort((a, b) => b.width - a.width);
              if (sources.length > 0 && sources[0].sourceUrl) { imageUrl = sources[0].sourceUrl; }
            }
            if (!imageUrl || imageUrl.startsWith('data:') || imageUrl.includes('blank')) {
              imageUrl = imgEl.dataset.src || imageUrl;
              if (imageUrl.startsWith('//')) { imageUrl = `https:${imageUrl}`; }
            }
            return {
              sourceUrl: imageUrl || '', // Ensure url is string
              alt_text: imgEl.alt || title || 'Product Image' // Ensure alt_text is string
            };
          })
          // Ensure filter condition results in boolean and matches IntermediateImage
          .filter((img): img is IntermediateImage => !!img.sourceUrl && !img.sourceUrl.startsWith('data:') && !img.sourceUrl.includes('blank') && !img.sourceUrl.includes('cdn.shopify.com/s/files/1/0681/6849/3914/files/1x1.gif'));
      }
      images = images.filter((img, index, self) => img.sourceUrl && self.findIndex(t => t.sourceUrl === img.sourceUrl) === index);

      const sizes: Size[] = Array.from(document.querySelectorAll(s.product.sizes))
        .map(element => ({
          size: element.getAttribute('value') || '',
          is_available: !element.hasAttribute('disabled') && !element.parentElement?.querySelector('label')?.classList.contains('line-through')
        }))
        .filter(size => size.size && size.size !== 'Select Size');

      const hasAvailableSize = sizes.some(s => s.is_available);
      const soldOutText = document.querySelector('.sold-out-text-selector')?.textContent?.trim();
      const product_status = soldOutText ? 'out_of_stock' : (hasAvailableSize ? 'in_stock' : 'out_of_stock');

      // Return object matching ScrapedData
      return {
        sourceUrl,
        title,
        description,
        product_status,
        images, // IntermediateImage[] is compatible
        price: isNaN(numericPrice) ? 0 : numericPrice, // Assign parsed number
        sale_price: numericSalePrice !== undefined && !isNaN(numericSalePrice) ? numericSalePrice : undefined, // Assign parsed number
        sizes,
        product_id,
        vendor: s.product.vendor,
        currency: 'EUR',
        tags: [],
        type: undefined
      };
    }, SELECTORS);

    // Prices are now numbers, no need for conversion here
    // const numericPrice = parseFloat(String(itemData.price || '0').replace(/,/g, '.')) || 0;
    // const numericSalePrice = itemData.sale_price ? parseFloat(String(itemData.sale_price).replace(/,/g, '.')) : undefined;

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

    // Construct final Item object
    const finalItem: Item = {
      sourceUrl,
      product_id: itemData.product_id,
      title: itemData.title,
      description: itemData.description,
      vendor: itemData.vendor,
      images: imagesWithMushUrl,
      price: itemData.price, // Already number
      sale_price: itemData.sale_price, // Already number or undefined
      currency: itemData.currency,
      sizes: itemData.sizes,
      status: itemData.product_status === 'out_of_stock' ? 'DELETED' : 'ACTIVE',
      tags: [],
      type: undefined
    };

    return Utils.formatItem(finalItem);

  } catch (error) {
    log.error(`Error scraping item at ${sourceUrl}:`, error);
    return Utils.formatItem({
      sourceUrl,
      product_id: '',
      title: `Error scraping item`,
      description: error instanceof Error ? error.message : String(error),
      status: undefined, // Use undefined for error status
      vendor: 'nerses',
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