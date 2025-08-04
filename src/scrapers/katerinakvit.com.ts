import type { Page } from 'playwright';
import type { Item, Image, Size } from '../types/item.js';
import * as Utils from "../db/db-utils.js";
// Site config is now managed by SiteManager service
import type { Scraper } from './types.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('katerinakvit.com');

export const SELECTORS = {
  productGrid: 'body', // Use body instead of specific selector to avoid timeout
  productLinks: 'body', // Use body instead of specific selector to avoid timeout
  pagination: {
    type: 'numbered' as const,
    nextButton: '.next.page-numbers',
    container: '.woocommerce-pagination', // Added container selector
    pattern: 'page/{n}'
  },
  product: {
    title: '.product_title.entry-title',
    price: '.price .woocommerce-Price-amount',
    salePrice: '.price del .woocommerce-Price-amount',
    regularPrice: '.price ins .woocommerce-Price-amount',
    productId: 'input[name="product_id"]',
    variationId: 'input[name="variation_id"]',
    sku: '.sku',
    images: '.kvit-product-gallery__item img, .kvit-product-gallery__item',
    sizes: '#pa_razmer option',
    description: '.tabs__content.active',
    details: '.tabs__content:not(.active)',
    availability: '.stock',
    category: '.product_cat',
    colors: '.ks_color_var_product',
    variationsForm: '.variations_form.cart',
    variationData: 'data-product_variations'
  }
};

export async function getItemUrls(page: Page): Promise<Set<string>> {
  // Wait for page to be ready
  await page.waitForLoadState('domcontentloaded');
  
  // Additional wait for dynamic content
  await page.waitForTimeout(1000);

  // Use multiple selectors to find product links
  const urls = await page.evaluate(() => {
    // Try multiple selectors based on the HTML structure
    const selectors = [
      '.product-div .woocommerce-LoopProduct-link',
      '.product-div a.woocommerce-loop-product__link',
      'li.product .woocommerce-LoopProduct-link',
      'li.product a.woocommerce-loop-product__link',
      '.products .product a[href*="/product/"]',
      'a.woocommerce-LoopProduct-link'
    ];
    
    let links: Element[] = [];
    for (const selector of selectors) {
      links = Array.from(document.querySelectorAll(selector));
      if (links.length > 0) {
        console.log(`Found ${links.length} products using selector: ${selector}`);
        break;
      }
    }
    
    // Filter to ensure we only get product URLs
    return links
      .map(link => (link as HTMLAnchorElement).href)
      .filter(href => href && href.includes('/product/'));
  });
  
  log.debug(`Found ${urls.length} product URLs on ${page.url()}`);
  return new Set(urls);
}

export async function paginate(page: Page): Promise<boolean> {
  try {
    const currentUrl = page.url();
    
    // First try to find a next button if pagination container exists
    try {
      await page.waitForSelector(SELECTORS.pagination.container, { timeout: 2000 });
      const nextLinkHandle = await page.$(SELECTORS.pagination.nextButton);
      
      if (nextLinkHandle) {
        const href = await nextLinkHandle.getAttribute('href');
        if (href) {
          const absoluteUrl = new URL(href, page.url()).href;
          const response = await page.goto(absoluteUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
          
          if (response && response.ok()) {
            await page.waitForTimeout(500);
            const urls = await getItemUrls(page);
            return urls.size > 0;
          }
        }
      }
    } catch (e) {
      // No pagination container found, try URL-based pagination
    }
    
    // Fallback to URL-based pagination pattern
    // Check if we're on a paginated URL like /page/2/
    const pageMatch = currentUrl.match(/\/page\/(\d+)\/?/);
    const currentPageNum = pageMatch ? parseInt(pageMatch[1], 10) : 1;
    const nextPageNum = currentPageNum + 1;
    
    let nextUrl: string;
    if (pageMatch) {
      // Replace existing page number
      nextUrl = currentUrl.replace(/\/page\/\d+\/?/, `/page/${nextPageNum}/`);
    } else {
      // Add page number to URL
      // Handle URLs with or without trailing slash
      if (currentUrl.endsWith('/')) {
        nextUrl = `${currentUrl}page/${nextPageNum}/`;
      } else {
        nextUrl = `${currentUrl}/page/${nextPageNum}/`;
      }
    }
    
    log.debug(`Attempting to navigate to page ${nextPageNum}: ${nextUrl}`);
    
    const response = await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    if (!response || !response.ok()) {
      log.debug(`No more pages - got ${response?.status()} for ${nextUrl}`);
      return false;
    }
    
    // Wait for content to load
    await page.waitForTimeout(1000);
    
    // Check if we have products on this page
    const urls = await getItemUrls(page);
    if (urls.size === 0) {
      log.debug(`No products found on page ${nextPageNum}`);
      return false;
    }
    
    log.debug(`Successfully navigated to page ${nextPageNum}, found ${urls.size} products`);
    return true;
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.debug(`Pagination ended: ${errorMessage}`);
    return false;
  }
}

// -----------------------
// Default export (Scraper)
// -----------------------

export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item[]> {
  const sourceUrl = page.url();
  try {
    // Page is already at sourceUrl, ensure content is loaded.
    await page.waitForSelector(SELECTORS.product.title, { timeout: 5000 });

    // Define intermediate type for data extracted by evaluate
    type ScrapedData = Omit<Item, 'images' | 'status'> & {
      images: Omit<Image, 'mushUrl'>[];
      // Add other potentially missing fields from Item if evaluate returns them
      product_status?: string; // Example if evaluate returns this
      regular_price?: number;
      colors?: string[];
      sku?: string;
    };

    const itemData: ScrapedData = await page.evaluate((selectors) => {
      const title = document.querySelector(selectors.title)?.textContent?.trim() || '';
      const product_id = document.querySelector(selectors.productId)?.getAttribute('value') || '';
      const sku = document.querySelector(selectors.sku)?.textContent?.replace('ID:', '').trim() || '';

      let variations: any[] = []; // Explicitly type variations
      try {
        const variationsForm = document.querySelector(selectors.variationsForm);
        if (variationsForm) {
          const variationsData = variationsForm.getAttribute(selectors.variationData);
          if (variationsData) {
            variations = JSON.parse(variationsData);
          }
        }
      } catch (e) { logger.error(`Error parsing variations: ${e}`); }

      const priceText = document.querySelector(selectors.price)?.textContent?.trim() || '0';
      let price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
      if (variations.length > 0 && variations[0].display_price) {
        price = variations[0].display_price;
      }
      let currency = 'UAH';
      if (priceText.includes('€')) { currency = 'EUR'; }
      else if (priceText.includes('$')) { currency = 'USD'; }

      let sale_price: number | undefined;
      const salePriceEl = document.querySelector(selectors.salePrice);
      let regular_price: number | undefined;
      const regularPriceEl = document.querySelector(selectors.regularPrice);

      if (salePriceEl && regularPriceEl) {
        const salePriceText = salePriceEl.textContent?.trim() || '0';
        const regularPriceText = regularPriceEl.textContent?.trim() || '0';
        sale_price = parseFloat(salePriceText.replace(/[^0-9.]/g, '')) || undefined;
        regular_price = parseFloat(regularPriceText.replace(/[^0-9.]/g, '')) || undefined;
        if (regular_price) price = regular_price;
      } else if (salePriceEl) {
        const salePriceText = salePriceEl.textContent?.trim() || '0';
        price = parseFloat(salePriceText.replace(/[^0-9.]/g, '')) || 0;
      } else if (regularPriceEl) {
        const regularPriceText = regularPriceEl.textContent?.trim() || '0';
        price = parseFloat(regularPriceText.replace(/[^0-9.]/g, '')) || 0;
      } else {
        price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
      }

      type IntermediateImage = { sourceUrl: string; alt_text: string };
      // Simplified image extraction: Select the anchor tags directly
      const images: IntermediateImage[] = Array.from(document.querySelectorAll('.kvit-product-gallery .kvit-product-gallery__item'))
        .map(anchor => {
          const a = anchor as HTMLAnchorElement;
          const img = a.querySelector('img') as HTMLImageElement | null;
          let url = a.href || ''; // Get URL from anchor href

          // Ensure URL is absolute
          if (url && !url.startsWith('http') && !url.startsWith('//')) {
            try { url = new URL(url, window.location.origin).href; } catch (_) { url = ''; }
          }

          return {
            sourceUrl: url || '',
            alt_text: img?.alt || title // Get alt text from nested img
          };
        })
        .filter((img): img is IntermediateImage => {
          return typeof img.sourceUrl === 'string' && img.sourceUrl.length > 0 && !img.sourceUrl.startsWith('data:') && !img.sourceUrl.toLowerCase().endsWith('.gif');
        })
        .filter((img, index, self) => index === self.findIndex((t) => t.sourceUrl === img.sourceUrl)); // Keep duplicate check

      const sizeOptions = document.querySelectorAll(selectors.sizes);
      let sizes: Size[] = Array.from(sizeOptions)
        .filter(option => option.getAttribute('value')) // Keep filtering out options without value
        .map(option => ({
          size: option.textContent?.trim() || '',
          // Robust boolean check for is_available, casting final result
          is_available: Boolean(variations.some((v: any) => {
            const isInStock = v.is_in_stock === true || String(v.is_in_stock).toLowerCase() === 'true';
            const isPurchasable = v.is_purchasable === true || String(v.is_purchasable).toLowerCase() === 'true';
            return v.attributes?.attribute_pa_razmer === option.getAttribute('value') && (isInStock || isPurchasable);
          }))
        }))
        .filter(size => size.size && size.size.toLowerCase() !== 'choose an option');

      if (variations.length > 0) {
        try {
          const variationSizesMap = new Map<string, { size: string; is_available: boolean }>();
          variations.forEach((v: any) => {
            const razmerValue = v.attributes?.attribute_pa_razmer;
            if (razmerValue) {
              const existing = variationSizesMap.get(razmerValue);
              // Robust boolean check, handling potential string values
              const isInStock = v.is_in_stock === true || String(v.is_in_stock).toLowerCase() === 'true';
              const isPurchasable = v.is_purchasable === true || String(v.is_purchasable).toLowerCase() === 'true';
              const is_available = Boolean(isInStock || isPurchasable); // Explicit cast
              if (!existing || (existing && !existing.is_available && is_available)) {
                variationSizesMap.set(razmerValue, { size: razmerValue, is_available: is_available });
              }
            }
          });
          const variationSizes = Array.from(variationSizesMap.values());
          if (variationSizes.length > 0) { sizes = variationSizes; }
        } catch (e) { logger.error(`Error extracting sizes from variations: ${e}`); }
      }

      const descriptionContent = document.querySelector(selectors.description)?.textContent?.trim() || '';
      const detailsContent = document.querySelector(selectors.details)?.textContent?.trim() || '';
      const fullDescription = [descriptionContent, detailsContent].filter(Boolean).join('\n\n');

      const colors = Array.from(document.querySelectorAll(selectors.colors))
        .map(color => color.querySelector('.ks_color_var_product__color-text')?.textContent?.trim())
        .filter((c): c is string => Boolean(c)); // Type guard for filter(Boolean)

      let product_status = 'in_stock';
      if (variations.length > 0) {
        if (variations.every((v: any) => !v.is_in_stock && !v.is_purchasable)) {
          product_status = 'out_of_stock';
        }
      } else {
        const availability = document.querySelector(selectors.availability)?.textContent?.trim() || '';
        if (availability.toLowerCase().includes('backorder')) { product_status = 'backorder'; }
        else if (availability.toLowerCase().includes('out of stock')) { product_status = 'out_of_stock'; }
      }

      const knownColors = new Set(colors.map(c => c.toLowerCase()));
      const invalidSizeTerms = new Set(['choose an option', 'select size']);
      const validSizes = sizes.filter(size => {
        const sizeNameLower = size.size.toLowerCase();
        return !knownColors.has(sizeNameLower) && !invalidSizeTerms.has(sizeNameLower);
      });

      // Return object matching ScrapedData type structure
      return {
        sourceUrl: window.location.href,
        product_id,
        title,
        description: fullDescription,
        product_status,
        images, // IntermediateImage[] is compatible with Omit<Image, 'mushUrl'>[]
        price,
        sale_price,
        regular_price,
        sizes: validSizes,
        colors,
        vendor: 'katerinakvit',
        currency,
        sku,
        tags: [], // Ensure tags is present
        type: undefined // Ensure type is present
      };
    }, SELECTORS.product);

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

    // Construct the final Item object
    const finalItem: Item = {
      ...itemData,
      images: imagesWithMushUrl, // Use processed images
      status: itemData.product_status === 'out_of_stock' ? 'DELETED' : 'ACTIVE' // Map product_status to Item status
      // Ensure all required fields from Item are present
    };

    return [Utils.formatItem(finalItem)];

  } catch (error) {
    log.error(`Error scraping item at ${sourceUrl}:`, error); // Use sourceUrl
    // Close the browser before re-throwing to ensure resources are cleaned up
    // if (browser && browser.isConnected()) { // Browser is managed by caller
    //   await browser.close();
    // }
    // Re-throw the error to be handled by the calling function
    throw error;
  }
}

const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper;