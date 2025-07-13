import { Page } from 'playwright';
import type { Item, Image, Size } from './types.js';
import { uploadImagesToS3AndAddUrls } from '../lib/image-utils.js';
import { logger } from '../lib/logger.js';

const DOMAIN = 'mocko-est2018.com';
const log = logger.createContext(DOMAIN);

export async function getItemUrls(page: Page): Promise<Set<string>> {
  const itemUrls = new Set<string>();
  
  // Wait for product links
  await page.waitForSelector('a.woocommerce-LoopProduct-link', { timeout: 10000 });
  
  // Since the page uses infinite scroll, we need to scroll and collect links
  let previousCount = 0;
  let currentCount = 0;
  let scrollAttempts = 0;
  const maxScrollAttempts = 20; // Increased to ensure we get all products

  do {
    previousCount = itemUrls.size;

    // Get all product links currently on the page
    const links = await page.locator('a.woocommerce-LoopProduct-link').evaluateAll(elements =>
      elements.map(el => (el as HTMLAnchorElement).href)
    );
    
    for (const link of links) {
      if (link) {
        itemUrls.add(new URL(link, page.url()).href);
      }
    }

    currentCount = itemUrls.size;

    // If we got new items, scroll to load more
    if (currentCount > previousCount) {
      scrollAttempts = 0; // Reset attempts if we're getting new items
      log.normal(`Scrolling... (${currentCount} items found)`);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(3000); // Wait longer for new items to load
    } else {
      scrollAttempts++;
    }

  } while (scrollAttempts < maxScrollAttempts && currentCount > previousCount);

  return itemUrls;
}

export async function paginate(page: Page): Promise<boolean> {
  // This site uses infinite scroll, not traditional pagination
  // Return false as we handle all items in getItemUrls
  return false;
}

/**
 * Scrapes item details from a product page.
 * @param page - The Playwright page object already navigated to the product URL
 * @param options - Optional configuration for scraping behavior
 * @returns The scraped item data
 */
export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  // Default to scraping images if not specified
  const scrapeImages = options?.scrapeImages !== false;
  
  // Wait for main content
  await page.waitForSelector('h1.product_title', { timeout: 10000 });
  
  // Extract basic product information
  const title = await page.$eval('h1.product_title', el => el.textContent?.trim() || '').catch(() => '');
  
  // Extract brand (always "Mocko" for this site)
  const brand = 'Mocko';
  
  // Extract description from short description
  const description = await page.$eval('.woocommerce-product-details__short-description', el => {
    const paragraphs = Array.from(el.querySelectorAll('p'));
    return paragraphs.map(p => p.textContent?.trim()).filter(Boolean).join(' ');
  }).catch(() => '');
  
  // Extract price (handle both regular and sale prices)
  const priceData = await page.$eval('.summary .price', el => {
    const salePrice = el.querySelector('ins .woocommerce-Price-amount');
    const regularPrice = el.querySelector('del .woocommerce-Price-amount');
    
    if (salePrice && regularPrice) {
      // It's on sale
      return {
        regularPrice: regularPrice.textContent?.trim() || '',
        salePrice: salePrice.textContent?.trim() || ''
      };
    } else {
      // Regular price only
      const normalPrice = el.querySelector('.woocommerce-Price-amount');
      return {
        regularPrice: normalPrice?.textContent?.trim() || '',
        salePrice: null
      };
    }
  }).catch(() => ({ regularPrice: '', salePrice: null }));
  
  const price = parseFloat(priceData.regularPrice.replace(/[^\d]/g, '')) || 0;
  const salePrice = priceData.salePrice ? parseFloat(priceData.salePrice.replace(/[^\d]/g, '')) : undefined;
  
  // Extract sizes from variation form
  const sizes: Size[] = await page.$$eval('.variations_form .swatch-label', elements =>
    elements.map(el => ({
      size: el.textContent?.trim() || '',
      is_available: !el.parentElement?.classList.contains('swatch-disabled')
    }))
  ).catch(() => []);

  // If no sizes found in swatches, try the select dropdown
  if (sizes.length === 0) {
    const sizeOptions = await page.$$eval('select#pa_size option', options =>
      options.filter(opt => opt.value).map(opt => ({
        size: opt.textContent?.trim() || '',
        is_available: true
      }))
    ).catch(() => []);
    sizes.push(...sizeOptions);
  }
  
  // Extract images conditionally
  let processedImages: Image[] = [];
  
  if (options?.existingImages && !scrapeImages) {
    // Use existing images from database - no scraping or S3 upload
    log.normal(`Using ${options.existingImages.length} existing images from database`);
    processedImages = options.existingImages.map(img => ({
      sourceUrl: img.sourceUrl,
      mushUrl: img.mushUrl,
      alt_text: undefined
    }));
  } else if (scrapeImages) {
    log.normal(`Scraping images for product`);
    
    // Wait for gallery images to load
    await page.waitForSelector('.woocommerce-product-gallery__image img', { timeout: 5000 }).catch(() => {});
    
    const imagesRaw = await page.$$eval('.woocommerce-product-gallery__image img', (imgs) => {
      return imgs.map(img => {
        // Get the full resolution image URL from data-large_image or src
        const largeImage = img.getAttribute('data-large_image') || img.getAttribute('data-src') || img.getAttribute('src') || '';
        const alt = img.getAttribute('alt') || '';
        
        // Skip placeholder images
        if (largeImage.includes('placeholder') || largeImage.includes('woocommerce-placeholder')) {
          return null;
        }
        
        return {
          sourceUrl: largeImage,
          alt: alt
        };
      }).filter(img => img !== null && img.sourceUrl) as Array<{sourceUrl: string; alt: string}>;
    }).catch(() => []);
    
    // Upload images to S3 if we found any
    if (imagesRaw.length > 0) {
      if (options?.uploadToS3 !== false) {

        processedImages = await uploadImagesToS3AndAddUrls(imagesRaw, DOMAIN);

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        processedImages = imagesRaw;

      }
      log.normal(`Uploaded ${processedImages.length} images to S3`);
    }
  } else {
    log.normal(`Skipping image scraping (already exists in database)`);
  }
  
  // Extract product ID from URL
  const urlMatch = page.url().match(/\/product\/([^\/]+)\/?/);
  const productId = urlMatch ? urlMatch[1] : '';
  
  // Extract SKU from meta or use product ID
  const sku = await page.$eval('.sku', el => el.textContent?.trim() || '').catch(() => productId);
  
  // Construct the item object
  const item: Item = {
    sourceUrl: page.url(),
    product_id: productId,
    title,
    vendor: brand,
    description,
    currency: 'UAH', // Ukrainian Hryvnia
    price: price || 0,
    sale_price: salePrice,
    sizes,
    images: processedImages,
    status: 'ACTIVE'
  };
  
  return item;
}

// For backward compatibility, export default object with all functions
export default {
  getItemUrls,
  paginate,
  scrapeItem
};