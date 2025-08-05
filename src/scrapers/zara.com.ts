import type { Page } from 'playwright';
import type { Item, Image, Size } from '../types/item.js';
import { formatItem } from '../db/db-utils.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('zara.com');

export const SELECTORS = {
  productGrid: '[data-qa-id="product-grid"]',
  productLinks: 'a.product-link',
  pagination: {
    type: 'scroll' as const,
    loadMoreButton: 'button[aria-label*="Load more"]'
  },
  product: {
    title: 'h1.product-detail-info__header-name',
    price: 'span.price-current__amount',
    originalPrice: 'span.price-old__amount',
    productId: '[data-productid]',
    images: '.media-image__image.media__wrapper--media',
    sizes: 'li.size-selector__size-list-item',
    description: '.expandable-text__inner-content',
    color: 'p.product-detail-selected-color'
  }
};

export async function getItemUrls(page: Page): Promise<Set<string>> {
  await page.waitForSelector(SELECTORS.productLinks, { timeout: 10000 });

  const urls = await page.evaluate(() => {
    const links = document.querySelectorAll('a.product-link');
    const urls: string[] = [];

    links.forEach(link => {
      const href = link.getAttribute('href');
      if (href) {
        const url = new URL(href, window.location.origin);
        urls.push(url.href);
      }
    });

    return urls;
  });

  return new Set(urls);
}

export async function paginate(page: Page): Promise<boolean> {
  // Count products before scroll
  const beforeCount = await page.$$eval(SELECTORS.productLinks, els => els.length);

  // Scroll to bottom to trigger lazy loading
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);

  // Count products after scroll
  const afterCount = await page.$$eval(SELECTORS.productLinks, els => els.length);

  if (afterCount > beforeCount) {
    return true;
  }

  // Check for load more button
  const loadMoreButton = await page.$(SELECTORS.pagination.loadMoreButton);
  if (loadMoreButton) {
    const isVisible = await loadMoreButton.isVisible().catch(() => false);
    if (isVisible) {
      try {
        await loadMoreButton.click({ timeout: 5000 });
        await page.waitForTimeout(2000);
        const newCount = await page.$$eval(SELECTORS.productLinks, els => els.length);
        return newCount > afterCount;
      } catch {
        // Ignore click errors
      }
    }
  }

  return false;
}

const parsePrice = (priceText: string): number => {
  if (!priceText) return 0;
  // Remove currency symbols and parse
  const cleaned = priceText.replace(/[^\d.,]/g, '').replace(',', '');
  return parseFloat(cleaned) || 0;
};

export async function scrapeItem(page: Page): Promise<Item[]> {
  try {
    await page.waitForSelector(SELECTORS.product.title, { timeout: 10000 });
    const sourceUrl = page.url();

    // Extract title
    const title = await page.$eval(SELECTORS.product.title, el => 
      el.textContent?.trim() || 'Unknown Product'
    ).catch(() => 'Unknown Product');

    // Extract product ID from URL or data attribute
    let productId = 'unknown';
    try {
      // Try to get from data attribute first
      productId = await page.$eval('[data-productid]', el => 
        el.getAttribute('data-productid') || 'unknown'
      ).catch(() => 'unknown');
      
      // Fallback to URL parsing
      if (productId === 'unknown') {
        const urlMatch = sourceUrl.match(/p(\d+)\.html/);
        if (urlMatch) {
          productId = urlMatch[1];
        }
      }
    } catch {
      // Keep default
    }

    // Extract prices
    let price = 0;
    let salePrice: number | undefined;

    try {
      // Check for sale price first (current price when on sale)
      const currentPriceText = await page.$eval(SELECTORS.product.price, el => 
        el.textContent?.trim() || ''
      ).catch(() => '');

      // Check for original price (crossed out price)
      const originalPriceText = await page.$eval(SELECTORS.product.originalPrice, el => 
        el.textContent?.trim() || ''
      ).catch(() => '');

      if (originalPriceText && currentPriceText) {
        // Item is on sale
        price = parsePrice(originalPriceText);
        salePrice = parsePrice(currentPriceText);
      } else if (currentPriceText) {
        // Regular price only
        price = parsePrice(currentPriceText);
      }
    } catch (e) {
      log.error('Price extraction failed:', e);
    }

    // Extract currency from price text
    let currency = 'USD';
    try {
      const priceElement = await page.$(SELECTORS.product.price);
      if (priceElement) {
        const priceText = await priceElement.textContent();
        if (priceText?.includes('€')) currency = 'EUR';
        else if (priceText?.includes('£')) currency = 'GBP';
        else if (priceText?.includes('$')) currency = 'USD';
      }
    } catch {
      // Keep default
    }

    // Extract images
    const rawImages = await page.$$eval(SELECTORS.product.images, (imgs) => {
      return imgs.map((img) => {
        const imgEl = img as HTMLImageElement;
        let url = imgEl.src || imgEl.getAttribute('data-src') || '';
        
        // Clean up Zara image URLs if needed
        if (url.includes('?')) {
          url = url.split('?')[0];
        }
        
        return {
          sourceUrl: url,
          alt_text: imgEl.alt || undefined
        };
      });
    }).catch(() => []);

    const validImages = rawImages.filter(img => 
      img.sourceUrl && 
      !img.sourceUrl.startsWith('data:') &&
      img.sourceUrl.startsWith('http')
    );

    // Upload images to S3
    const imagesWithMushUrl = await uploadImagesToS3AndAddUrls(validImages, sourceUrl);

    // Extract sizes
    const sizes = await page.$$eval(SELECTORS.product.sizes, (elements) => {
      return elements.map((el) => {
        const sizeText = el.textContent?.trim() || '';
        const isAvailable = !el.classList.contains('disabled') && 
                           !el.classList.contains('out-of-stock') &&
                           el.getAttribute('aria-disabled') !== 'true';
        
        return {
          size: sizeText,
          is_available: isAvailable
        };
      }).filter(s => s.size && s.size !== '');
    }).catch(() => []);

    // Extract description
    const description = await page.$eval(SELECTORS.product.description, el => 
      el.textContent?.trim() || ''
    ).catch(() => '');

    // Extract color if available
    const color = await page.$eval(SELECTORS.product.color, el => 
      el.textContent?.trim().replace(/^COLOR:\s*/i, '') || ''
    ).catch(() => '');

    // Construct item
    const item: Item = {
      sourceUrl,
      product_id: productId,
      title: color ? `${title} - ${color}` : title,
      description,
      images: imagesWithMushUrl,
      price,
      sale_price: salePrice,
      currency,
      sizes: sizes.length > 0 ? sizes : undefined,
      vendor: 'zara'
    };

    return [formatItem(item)];
  } catch (error) {
    log.error('Error scraping item:', error);
    return [];
  }
}

const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper;