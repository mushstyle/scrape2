import type { Page } from 'playwright';
import { logger } from '../utils/logger.js';
import type { Item, Image } from '../types/item.js';
import type { Scraper } from './types.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import { formatItem } from '../db/db-utils.js';

const log = logger.createContext('aninebing.com');

export const scraper: Scraper = {
  getItemUrls: async (page: Page) => {
    // Wait for product cards to load - try multiple times if needed
    let attempts = 0;
    while (attempts < 3) {
      try {
        await page.waitForSelector('.product-card', { timeout: 10000 });
        break;
      } catch (e) {
        attempts++;
        if (attempts >= 3) {
          log.error('Failed to find product cards after 3 attempts');
          return new Set();
        }
        log.debug(`Attempt ${attempts} failed, retrying...`);
        await page.waitForTimeout(2000);
      }
    }
    
    // Wait a bit for dynamic content to fully load
    await page.waitForTimeout(2000);
    
    // Get all product links from the image wrappers
    const urls = await page.$$eval('.fs-product-main-image-wrapper', (links) => {
      return links.map(link => {
        const href = (link as HTMLAnchorElement).href;
        // Filter out non-product URLs and normalize
        if (href && href.includes('/products/')) {
          // Remove query parameters like ?p=colsliderwrap
          const url = new URL(href);
          url.search = '';
          return url.href;
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
    // No pagination needed - startPages will have ?page=N parameters
    return false;
  },

  scrapeItem: async (page: Page, options?: { uploadToS3?: boolean }): Promise<Item[]> => {
    // Check for Cloudflare challenge
    try {
      // Look for Cloudflare checkbox iframe
      const cfFrame = page.frames().find(frame => frame.url().includes('challenges.cloudflare.com'));
      if (cfFrame) {
        log.debug('Cloudflare challenge detected, attempting to solve...');
        
        try {
          // Wait for the checkbox to be clickable
          const checkbox = await cfFrame.waitForSelector('input[type="checkbox"]', { timeout: 5000 });
          if (checkbox) {
            await checkbox.click();
            log.debug('Clicked Cloudflare checkbox');
            
            // Wait for challenge to complete and page to reload
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {
              // Sometimes navigation doesn't happen, just wait for content
              log.debug('No navigation after checkbox click, waiting for content...');
            });
            
            // Give it a moment to fully load
            await page.waitForTimeout(2000);
          }
        } catch (e) {
          log.debug('Could not click Cloudflare checkbox:', e);
          // Continue anyway, maybe the challenge resolved itself
        }
      }
      
      // Also check for text-based indicators
      const pageContent = await page.content();
      if (pageContent.includes('Your connection needs to be verified') || 
          pageContent.includes('Checking your browser')) {
        log.debug('Cloudflare text detected, waiting for auto-resolution...');
        await page.waitForTimeout(5000);
      }
    } catch (e) {
      log.debug('Error checking for Cloudflare challenge:', e);
    }
    
    // Wait for product content to load
    await page.waitForSelector('[data-product-json], .product-meta, .product__title', { timeout: 7000 });
    
    const sourceUrl = page.url();
    
    // Initialize variables
    let name = '';
    let price = '';
    let sale_price = '';
    let description = '';
    let images: string[] = [];
    
    // Get product name - try multiple selectors
    const nameSelectors = [
      'h1.product__title',
      '.product__title',
      'h1[itemprop="name"]',
      '.product-meta h1',
      'h1'
    ];
    
    for (const selector of nameSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          const text = await element.textContent();
          if (text && text.trim() && !text.includes('SPEND') && !text.includes('OFF')) {
            name = text.trim();
            break;
          }
        }
      } catch (e) {
        // Try next selector
      }
    }
    
    // Get price - check for sale price first, then regular price
    try {
      // First try to get both prices to determine if it's actually a sale
      let finalPriceText = null;
      let compareAtPriceText = null;
      
      try {
        finalPriceText = await page.$eval('.price--final .price__value', el => {
          const text = el.textContent?.trim() || '';
          const match = text.match(/\$?(\d+(?:\.\d{2})?)/);
          return match ? match[1] : null;
        });
      } catch (e) {
        // No final price
      }
      
      try {
        compareAtPriceText = await page.$eval('.price--compare-at .price__value', el => {
          const text = el.textContent?.trim() || '';
          const match = text.match(/\$?(\d+(?:\.\d{2})?)/);
          return match ? match[1] : null;
        });
      } catch (e) {
        // No compare-at price
      }
      
      // Determine if this is a sale or regular price
      if (finalPriceText && compareAtPriceText) {
        const finalPrice = parseFloat(finalPriceText);
        const comparePrice = parseFloat(compareAtPriceText);
        
        // Only treat as sale if compare price is greater than 0 and greater than final price
        if (comparePrice > 0 && comparePrice > finalPrice) {
          price = compareAtPriceText;
          sale_price = finalPriceText;
        } else {
          // Not a real sale - just use final price as regular price
          price = finalPriceText;
        }
      } else if (finalPriceText) {
        // Only final price exists - use as regular price
        price = finalPriceText;
      }
    } catch (e) {
      // Error getting prices
    }
    
    // If no prices found yet, try other selectors
    if (!price && !sale_price) {
      const priceSelectors = [
        '.pricing__values .price__value',
        '.product__price',
        '.price__regular',
        '.product-price',
        '[data-product-price]',
        '.price'
      ];
      
      for (const selector of priceSelectors) {
        try {
          const priceText = await page.$eval(selector, el => {
            const text = el.textContent?.trim() || '';
            const match = text.match(/\$?(\d+(?:\.\d{2})?)/);
            return match ? match[1] : null;
          });
          if (priceText) {
            price = priceText;
            break;
          }
        } catch (e) {
          // Try next selector
        }
      }
    }
    
    // Get description
    const descriptionSelectors = [
      '.product__description',
      '.product-description',
      '[data-product-description]',
      '.description'
    ];
    
    for (const selector of descriptionSelectors) {
      try {
        const desc = await page.$eval(selector, el => el.textContent?.trim() || '');
        if (desc) {
          description = desc;
          break;
        }
      } catch (e) {
        // Try next selector
      }
    }
    
    // Get sizes
    const sizes = await page.$$eval('.form__field--sizes label', labels => {
      return labels.map(label => {
        const sizeText = label.textContent?.trim() || '';
        const isDisabled = label.classList.contains('is-disabled') || label.hasAttribute('disabled');
        return {
          size: sizeText,
          is_available: !isDisabled
        };
      }).filter(s => s.size && !['Select a Size'].includes(s.size));
    }).catch(() => []);
    
    // Get images - wait for them to load and scroll to trigger lazy loading
    await page.waitForTimeout(1000);
    
    // Scroll to trigger lazy loading
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(1000);
    
    // Extract images from the product media section
    try {
      const imageUrls = await page.evaluate(() => {
        // Look for images in the product media wrapper
        const imgElements = document.querySelectorAll('.product__media-wrap img, .product-media-grid img, .product-media-slider img');
        const urls: string[] = [];
        
        imgElements.forEach(img => {
          const element = img as HTMLImageElement;
          // Try data-src first (for lazy loaded images), then src
          const url = element.getAttribute('data-src') || element.src;
          
          if (url && 
              !url.includes('data:image') && 
              !url.includes('placeholder') &&
              (url.includes('/files/') || url.includes('cdn/shop'))) {
            // Clean up the URL - remove size parameters
            let cleanUrl = url;
            // Remove size suffix like _700x.jpg to get larger image
            cleanUrl = cleanUrl.replace(/_\d+x\.(jpg|png|webp)/i, '_1700x.$1');
            
            // Ensure it starts with https
            if (cleanUrl.startsWith('//')) {
              cleanUrl = 'https:' + cleanUrl;
            }
            
            urls.push(cleanUrl);
          }
        });
        
        // Remove duplicates
        return [...new Set(urls)];
      });
      
      if (imageUrls.length > 0) {
        images = imageUrls;
        log.debug(`Found ${imageUrls.length} product images`);
      }
    } catch (e) {
      log.error('Error extracting images:', e);
    }
    
    // Get color if available
    const colorSelectors = [
      '.color-swatch__name',
      '.color-option.selected',
      '[data-option-name="Color"] .selected',
      '.swatch.selected'
    ];
    
    let color = '';
    for (const selector of colorSelectors) {
      try {
        const colorText = await page.$eval(selector, el => el.textContent?.trim() || '');
        if (colorText) {
          color = colorText;
          break;
        }
      } catch (e) {
        // Try next selector
      }
    }
    
    // Get product ID from URL or page data
    let product_id = '';
    try {
      // Try to extract from URL first
      const urlMatch = sourceUrl.match(/\/products\/([\w-]+)/);
      if (urlMatch) {
        product_id = urlMatch[1];
      }
      
      // If not found in URL, try data attributes
      if (!product_id) {
        product_id = await page.$eval('[data-product-id]', el => el.getAttribute('data-product-id') || '');
      }
    } catch (e) {
      // Generate from name if nothing else works
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