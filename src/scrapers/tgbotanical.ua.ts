import type { Page } from 'playwright';
// import playwright from 'playwright'; // Removed playwright import
import type { Item, Image } from '../types/item.js'; // Import from db/types.js
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js'; // Corrected function name
import { formatItem } from '../db/db-utils.js'; // Import formatItem directly
import { logger } from '../utils/logger.js';

const log = logger.createContext('tgbotanical.ua');

// Helper function to handle the shipping location modal if it appears
async function handleShippingModal(page: Page): Promise<void> {
  const modalSelector = 'div.shipping_location-modal[style*="display: block"]';
  try {
    await page.waitForSelector(modalSelector, { timeout: 7000 }); // Increased timeout for modal
    const ukraineButtonSelector = 'a.shipping_location-modal--continue[data-url*="set-shipping-location"]';
    // Checking visibility before clicking is a good practice
    if (await page.locator(ukraineButtonSelector).isVisible()) {
      await page.click(ukraineButtonSelector);
      await page.waitForLoadState('networkidle');
    }
  } catch (error) {
    log.normal('Shipping modal did not appear or was handled within timeout.');
  }
}

export async function getItemUrls(page: Page): Promise<Set<string>> {
  await handleShippingModal(page);
  // Ensure the main product grid selector is robust
  await page.waitForSelector('.products-list .grid-wrapper .product a', { timeout: 10000 });

  const urls = await page.evaluate(() => {
    const productLinks = Array.from(document.querySelectorAll('.products-list .grid-wrapper .grid-block .product a'));
    return productLinks.map(link => (link as HTMLAnchorElement).href);
  });
  // Ensure URLs are absolute
  return new Set(urls.map(url => new URL(url, page.url()).href));
}

export async function paginate(page: Page): Promise<boolean> {
  await handleShippingModal(page);
  // Using a more specific selector for the next button link inside the list item
  const nextButtonSelector = '.pagination ul.pagination__ul li.next a:not([disabled])';

  try {
    const nextButton = page.locator(nextButtonSelector); // Use page.locator
    if (await nextButton.count() > 0) { // Check if the locator finds any element
      // Check if the parent li has a class 'disabled' as an additional guard, though the :not([disabled]) should cover it.
      const parentLi = nextButton.locator('xpath=..'); // Get parent element
      if (await parentLi.getAttribute('class') === 'disabled') {
        log.normal('Next button\'s parent li is disabled, end of pagination.');
        return false;
      }
      await nextButton.click();
      await page.waitForLoadState('domcontentloaded');
      return true;
    } else {
      // Also check for the case where the 'next' li itself is disabled, meaning no 'a' tag might be present or it is styled as disabled.
      const disabledNextLiSelector = '.pagination ul.pagination__ul li.next.disabled';
      if (await page.locator(disabledNextLiSelector).count() > 0) {
        log.normal('Next button li is marked as disabled, end of pagination.');
        return false;
      }
      log.normal('No active next button found, assuming end of pagination.');
      return false;
    }
  } catch (error) {
    log.error('Error during pagination:', error);
    return false;
  }
}

const parsePrice = (priceText: string | null | undefined): number | undefined => {
  if (!priceText) return undefined;
  const cleanedText = priceText.replace(/\s+/g, '').replace(/[^\d.,]/g, '').replace(',', '.');
  const price = parseFloat(cleanedText);
  return isNaN(price) ? undefined : price;
};

export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item[]> {
  const sourceUrl = page.url();
  let item: Item | null = null;
  try {
    // Page is already at sourceUrl. Caller should handle modals and ensure page is settled.
    // await handleShippingModal(page); // Responsibility of the caller
    // await page.waitForLoadState('domcontentloaded', { timeout: 10000 }); // Responsibility of the caller
    // await page.waitForLoadState('networkidle', { timeout: 10000 }); // Responsibility of the caller

    // More specific selectors for product page based on provided HTML structure and common patterns
    await page.waitForSelector('div.product-info h1.name', { timeout: 10000 }); // Updated Product title selector
    await page.waitForSelector('.price-block .price, .product-price, .current-price, .product-info .price-article span.price', { timeout: 5000 }); // Updated Price element selector

    const rawDetails = await page.evaluate(() => {
      const title = document.querySelector('div.product-info h1.name')?.textContent?.trim() || ''; // Updated title selector

      const priceElement = document.querySelector('.product-info .price-article span.price, .price-block .price, .product-price, .current-price, .price span[itemprop="price"]'); // Updated price selector
      const priceText = priceElement?.textContent?.trim();

      // Currency is consistently UAH in the provided examples
      let currency = 'UAH';
      const priceTextContent = priceElement?.textContent || '';
      if (priceTextContent.includes('USD') || priceTextContent.includes('$')) currency = 'USD';
      if (priceTextContent.includes('EUR') || priceTextContent.includes('€')) currency = 'EUR';

      const descriptionElement = document.querySelector('.product-description'); // Updated description selector
      const description = descriptionElement?.innerHTML.trim() || descriptionElement?.textContent?.trim() || ''; // Prefer innerHTML for descriptions

      // Image selectors for product page gallery
      const imageAnchorElements = Array.from(document.querySelectorAll('#product-images .owl-item:not(.cloned) figure.easyzoom a'));
      let preliminaryImagesData = imageAnchorElements.map(anchor => {
        const imgElement = anchor.querySelector('img');
        return {
          src: (anchor as HTMLAnchorElement).href,
          alt: imgElement ? imgElement.alt : title, // Use title as fallback alt text
        };
      }).filter(img => img.src); // Filter out any images without a src

      // Deduplicate images based on src URL
      const uniqueImagesData = preliminaryImagesData.reduce((acc, current) => {
        if (!acc.find(item => item.src === current.src)) {
          acc.push(current);
        }
        return acc;
      }, [] as { src: string; alt: string }[]);

      const skuElement = document.querySelector('.product-info .price-article span.article'); // Updated SKU selector
      const skuText = skuElement?.textContent?.trim();
      const sku = skuText ? skuText.replace(/vendor code /i, '').trim() : undefined;

      const sizeElements = Array.from(document.querySelectorAll('select#groupSizes option:not([value=""])')); // Updated size selector
      const sizes = sizeElements.map(el => el.textContent?.trim()).filter(s => !!s) as string[];

      const brandElement = document.querySelector('.product-info span.made-by'); // Updated brand selector
      const brand = brandElement ? brandElement.textContent?.trim() : 'T|G botanical';

      const categoryElements = document.querySelectorAll('.breadcrumbs__list .breadcrumbs__item a, .breadcrumbs .breadcrumb a');
      const categories = Array.from(categoryElements).map(el => el.textContent?.trim()).filter(c => !!c) as string[];
      const category = categories.length > 1 ? categories[categories.length - 2] : (categories.length > 0 ? categories[0] : undefined); // Second to last, or first if only one ancsestor

      let color: string | undefined = undefined;
      if (uniqueImagesData.length > 0 && uniqueImagesData[0].alt) {
        // Try to extract color from alt text like "Top Melissa 6667026-735-299 Beige - TGBotanical"
        const altParts = uniqueImagesData[0].alt.split(' - ')[0].split(' ');
        if (altParts.length > 1) {
          // Potentially the color is the word before the SKU-like part or the last word if no SKU is obvious in the name part.
          // This is heuristic and might need adjustment based on more examples.
          const potentialColor = altParts[altParts.length - 1];
          // Avoid picking up numbers or very short strings as color
          if (potentialColor && potentialColor.length > 2 && !/^\d+$/.test(potentialColor)) {
            color = potentialColor;
          }
        }
      }

      return {
        title,
        priceText,
        currency,
        description,
        images: uniqueImagesData, // Return deduplicated images
        sku,
        sizes,
        sourceUrl: window.location.href,
        brand,
        category,
        color,
      };
    });

    const price = parsePrice(rawDetails.priceText);

    // Ensure image URLs are absolute before processing
    const absoluteImagePayloads = rawDetails.images.map(img => ({
      sourceUrl: new URL(img.src as string, sourceUrl).href, // Resolve relative image URLs
      altText: img.alt as string,
    }));
    // Image handling with existing images support
    let processedImages: Image[];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
      log.normal(`Using ${options.existingImages.length} existing images from database`);
      processedImages = options.existingImages.map(img => ({
        sourceUrl: img.sourceUrl,
        mushUrl: img.mushUrl,
        alt_text: undefined
      }));
    } else {
      if (options?.uploadToS3 !== false) {

        processedImages = await uploadImagesToS3AndAddUrls(absoluteImagePayloads, sourceUrl);

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        processedImages = absoluteImagePayloads;

      }
    }

    item = formatItem({
      title: rawDetails.title,
      price: price ?? 0,
      sale_price: undefined, // TODO: Implement sale price detection if applicable
      currency: rawDetails.currency.toUpperCase(),
      description: rawDetails.description,
      images: processedImages.map((p: { mushUrl?: string; sourceUrl: string; altText?: string }) => ({
        sourceUrl: p.sourceUrl, // The original URL from before S3 upload
        mushUrl: p.mushUrl,
        alt_text: p.altText,
      })),
      sizes: rawDetails.sizes.map((s: string) => ({ size: s, is_available: true })), // Assume all scraped sizes are available
      product_id: 'temp-id', // Placeholder, will be replaced by mkItemId later or derived
      sourceUrl: rawDetails.sourceUrl,
      vendor: rawDetails.brand, // Map brand to vendor
      type: rawDetails.category,   // Map category to type
      color: rawDetails.color,     // Add color
    });

  } catch (error) {
    log.error(`Error scraping ${sourceUrl}:`, error);
    throw new Error(`Failed to scrape ${sourceUrl}: ${(error as Error).message}`);
  }

  if (!item) {
    throw new Error(`Item could not be scraped from ${sourceUrl}`);
  }
  return item;
}

const scraper = {
  paginate,
  getItemUrls,
  scrapeItem,
};

export default scraper; 