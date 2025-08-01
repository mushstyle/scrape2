import type { Page } from 'playwright';
import { logger } from '../utils/logger.js';
import type { Item, Image } from '../types/item.js';
import type { Scraper } from './types.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import { formatItem } from '../db/db-utils.js';

const log = logger.createContext('us.maje.com');

export const scraper: Scraper = {
  getItemUrls: async (page: Page) => {
    // Wait for product grid to load
    try {
      await page.waitForSelector('.product-grid, .product, .product-tile', { timeout: 10000 });
    } catch (e) {
      log.debug('Product grid selector not found, waiting extra time');
    }
    
    // Additional wait to ensure products are rendered
    await page.waitForTimeout(2000);
    
    // Get all product URLs
    const urls = await page.$$eval('a[href*="/p/"]', (links) => {
      return links.map(link => {
        const href = (link as HTMLAnchorElement).href;
        // Filter to ensure we only get product URLs
        if (href && href.includes('/p/') && href.includes('.html')) {
          return href;
        }
        return null;
      }).filter((url): url is string => url !== null);
    });
    
    // Remove duplicates
    const uniqueUrls = [...new Set(urls)];
    log.debug(`Found ${uniqueUrls.length} unique product URLs from ${urls.length} total links`);
    
    return new Set(uniqueUrls);
  },

  paginate: async (page: Page) => {
    // Look for the "More products" button
    try {
      // Find the button with class "more" or containing "More products" text
      const moreButton = await page.$('a.more.plp-action-btn, button.more.plp-action-btn');
      
      if (moreButton) {
        // Check if button is visible and has more products to load
        const buttonText = await moreButton.textContent();
        log.debug(`Found 'More products' button: ${buttonText}`);
        
        // Click the button
        await moreButton.click();
        
        // Wait for new products to load
        await page.waitForTimeout(3000);
        
        log.debug('Clicked "More products" button and loaded more items');
        return true;
      }
    } catch (e) {
      log.debug('Error handling "More products" button:', e);
    }
    
    // Fallback: Check for infinite scroll by counting products
    const initialCount = await page.$$eval('a[href*="/p/"]', links => links.length);
    log.debug(`Current product count: ${initialCount}`);
    
    // Scroll to bottom to potentially trigger infinite scroll
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    
    // Count products again
    const newCount = await page.$$eval('a[href*="/p/"]', links => links.length);
    
    if (newCount > initialCount) {
      log.debug(`Infinite scroll loaded ${newCount - initialCount} more products`);
      return true;
    }
    
    log.debug('No more products to load');
    return false;
  },

  scrapeItem: async (page: Page, options?: { uploadToS3?: boolean }): Promise<Item[]> => {
    // Wait for product content to load
    await page.waitForSelector('h1', { timeout: 10000 });
    
    const sourceUrl = page.url();
    
    // Initialize variables
    let name = '';
    let price = '';
    let sale_price = '';
    let description = '';
    let images: string[] = [];
    
    // Get product name
    try {
      name = await page.$eval('h1', el => el.textContent?.trim() || '');
    } catch (e) {
      log.error('Failed to get product name');
    }
    
    // Get price - handle both regular and sale prices
    try {
      // Check if there's a price reduction
      const priceText = await page.$eval('.price', el => el.textContent || '');
      
      // Look for patterns like "Price reduced from $X to $Y"
      const priceMatch = priceText.match(/\$(\d+(?:\.\d{2})?)/g);
      
      if (priceMatch && priceMatch.length >= 2) {
        // Sale scenario: first price is original, last is sale
        price = priceMatch[0].replace('$', '');
        sale_price = priceMatch[priceMatch.length - 1].replace('$', '');
      } else if (priceMatch && priceMatch.length === 1) {
        // Regular price only
        price = priceMatch[0].replace('$', '');
      }
    } catch (e) {
      log.debug('Failed to get price using primary method');
      
      // Fallback: try other price selectors
      try {
        const regularPrice = await page.$eval('.regular-price, .price-regular', el => {
          const text = el.textContent || '';
          const match = text.match(/\$(\d+(?:\.\d{2})?)/);
          return match ? match[1] : '';
        });
        if (regularPrice) price = regularPrice;
        
        const salePrice = await page.$eval('.sale-price, .price-sale', el => {
          const text = el.textContent || '';
          const match = text.match(/\$(\d+(?:\.\d{2})?)/);
          return match ? match[1] : '';
        });
        if (salePrice) sale_price = salePrice;
      } catch (e2) {
        log.debug('Fallback price extraction also failed');
      }
    }
    
    // Get description
    try {
      description = await page.$eval('.product-description, .description, [data-description]', el => 
        el.textContent?.trim() || ''
      );
    } catch (e) {
      log.debug('No description found');
    }
    
    // Get sizes
    const sizes = await page.$$eval('select[name*="size"] option, .size-selector button, .size-option, input[type="radio"][name*="size"]', elements => {
      return elements.map(el => {
        let sizeText = '';
        let isAvailable = true;
        
        if (el.tagName === 'OPTION') {
          // Select option
          const option = el as HTMLOptionElement;
          sizeText = option.textContent?.trim() || option.value;
          isAvailable = !option.disabled;
        } else if (el.tagName === 'INPUT') {
          // Radio button
          const input = el as HTMLInputElement;
          const label = document.querySelector(`label[for="${input.id}"]`) || el.nextElementSibling;
          sizeText = label?.textContent?.trim() || input.value;
          isAvailable = !input.disabled;
        } else {
          // Button or div
          sizeText = el.textContent?.trim() || '';
          isAvailable = !el.classList.contains('disabled') && !el.hasAttribute('disabled');
        }
        
        return {
          size: sizeText,
          is_available: isAvailable
        };
      }).filter(s => s.size && s.size !== 'Select a Size' && s.size.toLowerCase() !== 'size');
    }).catch(() => []);
    
    // Get images
    try {
      // Wait for images to load
      await page.waitForTimeout(1000);
      
      // Extract images - Maje typically uses a carousel or gallery
      const imageUrls = await page.evaluate(() => {
        // First try to find the main product image container
        const productContainer = document.querySelector('.product-detail, .pdp-main, .product-main, .product-container') || document.body;
        
        const imgSelectors = [
          '.product-images img',
          '.product-gallery img',
          '.carousel-inner img',
          '.swiper-slide img',
          '[data-gallery] img',
          '.product-photo img',
          '.product-image-main img'
        ];
        
        const urls: string[] = [];
        
        for (const selector of imgSelectors) {
          const imgs = productContainer.querySelectorAll(selector);
          if (imgs.length > 0) {
            imgs.forEach(img => {
              const element = img as HTMLImageElement;
              // Try data-src first (for lazy loaded images), then src
              const url = element.getAttribute('data-src') || 
                         element.getAttribute('data-zoom') || 
                         element.src;
              
              if (url && 
                  !url.includes('data:image') && 
                  !url.includes('placeholder') &&
                  (url.includes('.jpg') || url.includes('.jpeg') || url.includes('.png') || url.includes('.webp'))) {
                // Ensure absolute URL
                const absoluteUrl = url.startsWith('http') ? url : new URL(url, window.location.origin).href;
                // Only include images that seem to be for this product (exclude recommendation carousels)
                if (!absoluteUrl.includes('/recommendations/') && !urls.includes(absoluteUrl)) {
                  urls.push(absoluteUrl);
                }
              }
            });
            if (urls.length > 0) break; // Use first selector that finds images
          }
        }
        
        // If we found too many images (likely picked up other products), limit to first 10
        return urls.slice(0, 10);
      });
      
      if (imageUrls.length > 0) {
        images = imageUrls;
        log.debug(`Found ${imageUrls.length} product images`);
      }
    } catch (e) {
      log.error('Error extracting images:', e);
    }
    
    // Get color if available
    let color = '';
    try {
      color = await page.$eval('.selected-color, .color-name, [data-color], .color-option.selected', el => 
        el.textContent?.trim() || ''
      );
    } catch (e) {
      // Color not found
    }
    
    // Get product ID from URL
    let product_id = '';
    try {
      // Extract from URL pattern: /p/[product-name]/[PRODUCT_CODE].html
      const urlMatch = sourceUrl.match(/\/([A-Z0-9_]+)\.html$/);
      if (urlMatch) {
        product_id = urlMatch[1];
      } else {
        // Fallback: use product name
        product_id = name.toLowerCase().replace(/\s+/g, '-');
      }
    } catch (e) {
      product_id = name.toLowerCase().replace(/\s+/g, '-');
    }
    
    // Extract images and prepare for S3 upload
    const imageObjects = images.map(url => ({
      sourceUrl: url,
      alt_text: name
    }));
    
    let finalImages: Image[] = imageObjects;
    
    if (options?.uploadToS3 !== false && imageObjects.length > 0) {
      log.debug(`Uploading ${imageObjects.length} images to S3...`);
      finalImages = await uploadImagesToS3AndAddUrls(imageObjects, sourceUrl);
    }
    
    // Create the item object
    const item: Item = {
      sourceUrl,
      product_id,
      title: name,
      description: description || undefined,
      images: finalImages,
      price: price ? parseFloat(price) : 0,
      sale_price: sale_price ? parseFloat(sale_price) : undefined,
      currency: 'USD',
      color: color || undefined,
      sizes: sizes.length > 0 ? sizes : undefined
    };
    
    log.debug(`Scraped item: ${item.title} - $${item.price} (${sizes.length} sizes)`);
    return [formatItem(item)];
  }
};

export default scraper;