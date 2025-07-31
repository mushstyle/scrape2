import type { Page } from 'playwright';
import type { Scraper, Item, Image } from './types.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('formi.com.ua');
const startUrl = 'https://formi.com.ua/shop/';

// Local helper function for parsing price (as recommended by rules if needed)
const parsePrice = (priceText: string | null): number | undefined => {
  if (!priceText) return undefined;
  const cleanedText = priceText.replace(/[^\d.,]/g, '').replace(',', '.'); // Normalize decimal separator
  const price = parseFloat(cleanedText);
  return isNaN(price) ? undefined : price;
};

export const paginate = async (page: Page): Promise<boolean> => {
  const currentPageNumberElement = await page.locator('div.pages span.page-numbers.current').first();
  // Check if currentPageNumberElement exists before trying to get its text content
  if (!await currentPageNumberElement.count()) {
    // This could mean it's the first page, or the only page, or an unexpected structure.
    // Let's try to find the next page link directly. If page 2 exists, we paginate.
    const nextPageLinkPage2 = await page.locator('div.pages a.page-numbers[href*="/page/2/"]').first();
    if (await nextPageLinkPage2.count() > 0) {
      const nextPageUrl = await nextPageLinkPage2.getAttribute('href');
      if (nextPageUrl) {
        await page.goto(nextPageUrl);
        return true;
      }
    }
    log.normal('Could not find current page number element, or it is the only page.');
    return false;
  }

  const currentPageNumberText = await currentPageNumberElement.textContent();
  if (!currentPageNumberText) {
    log.error('Could not get text content of current page number element.');
    return false;
  }
  const currentPageNumber = parseInt(currentPageNumberText.trim(), 10);
  if (isNaN(currentPageNumber)) {
    log.error('Could not parse current page number.');
    return false;
  }

  const nextPageNumber = currentPageNumber + 1;
  const nextPageLinkLocator = page.locator(`div.pages a.page-numbers[href*="/page/${nextPageNumber}/"]`);

  if (await nextPageLinkLocator.count() > 0) {
    const nextPageLink = nextPageLinkLocator.first();
    const nextPageUrl = await nextPageLink.getAttribute('href');
    if (nextPageUrl) {
      await page.goto(nextPageUrl);
      return true;
    } else {
      log.normal('No next page URL found on link.');
      return false;
    }
  } else {
    log.normal('No next page link found, assuming end of pagination.');
    return false;
  }
};

export const getItemUrls = async (page: Page): Promise<Set<string>> => {
  const itemUrls = new Set<string>();
  const productLocators = page.locator('ul.products li.product h4.mfn-woo-product-title a');
  const count = await productLocators.count();

  for (let i = 0; i < count; i++) {
    const productLocator = productLocators.nth(i);
    const href = await productLocator.getAttribute('href');
    if (href) {
      // Ensure URL is absolute
      itemUrls.add(new URL(href, page.url()).href);
    }
  }
  return itemUrls;
};

export const scrapeItem = async (page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> => {
  const sourceUrl = page.url();
  try {
    // Page is already at sourceUrl, ensure content is loaded.
    // await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }); // Removed goto

    const rawDetails = await page.evaluate(() => {
      const title = document.querySelector('h1.woocommerce-products-header__title')?.textContent?.trim() || '';

      const priceElement = document.querySelector('div.price span.woocommerce-Price-amount.amount bdi');
      let priceText = priceElement?.textContent?.trim() || null;
      let currencySymbol = document.querySelector('div.price span.woocommerce-Price-amount.amount span.woocommerce-Price-currencySymbol')?.textContent?.trim() || null;

      // If bdi is not found or doesn't contain the full price, try to get it from the parent and extract symbol manually
      if (priceElement && (!priceText || !currencySymbol)) {
        const fullPriceText = priceElement.textContent?.trim();
        if (fullPriceText) {
          const match = fullPriceText.match(/([\d,.]+)([^\d,.]*)$/);
          if (match) {
            priceText = match[1];
            currencySymbol = match[2].trim();
          }
        }
      } else if (!priceElement) { // Fallback if bdi is not present at all
        const generalPriceElement = document.querySelector('div.price span.woocommerce-Price-amount.amount');
        const fullPriceText = generalPriceElement?.textContent?.trim();
        if (fullPriceText) {
          const match = fullPriceText.match(/([\d,.]+)([^\d,.]*)$/);
          if (match) {
            priceText = match[1];
            currencySymbol = match[2].trim();
          }
        }
      }


      const descriptionHTML = document.querySelector('div.woocommerce-product-details__description div.the_content_wrapper')?.innerHTML || '';

      const productIdAttribute = document.querySelector('button.single_add_to_cart_button[name="add-to-cart"]')?.getAttribute('value') || '';

      const imageElements = Array.from(document.querySelectorAll('figure.woocommerce-product-gallery__wrapper div.woocommerce-product-gallery__image a'));
      const imagesData = imageElements.map(a => ({
        sourceUrl: (a as HTMLAnchorElement).href,
        alt_text: (a.querySelector('img') as HTMLImageElement)?.alt || title || 'product image'
      }));

      // Extract additional attributes
      const attributes: { name: string; value: string }[] = [];
      document.querySelectorAll('table.woocommerce-product-attributes tr').forEach(row => {
        const label = row.querySelector('th.woocommerce-product-attributes-item__label span')?.textContent?.trim();
        const value = row.querySelector('td.woocommerce-product-attributes-item__value span')?.textContent?.trim();
        if (label && value) {
          attributes.push({ name: label, value });
        }
      });

      return {
        title,
        priceText,
        currencySymbol,
        descriptionHTML,
        productIdAttribute,
        imagesData,
        attributes
      };
    });

    const price = parsePrice(rawDetails.priceText);
    let currency = 'EUR'; // Default
    if (rawDetails.currencySymbol === '€') currency = 'EUR';
    else if (rawDetails.currencySymbol === '₴') currency = 'UAH';
    // Add other currency mappings if needed

    // Image handling with existing images support
    let images: Image[];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
      log.normal(`Using ${options.existingImages.length} existing images from database`);
      images = options.existingImages.map(img => ({
        sourceUrl: img.sourceUrl,
        mushUrl: img.mushUrl,
        alt_text: undefined
      }));
    } else {
      // Note: This scraper doesn't currently upload to S3, just maps the images
      images = rawDetails.imagesData.map(img => ({ sourceUrl: img.sourceUrl, alt_text: img.alt_text }));
      // TODO: Implement S3 upload with uploadImagesToS3AndAddUrls
    }

    const tags: string[] = rawDetails.attributes.map(attr => `${attr.name}: ${attr.value}`);


    const item: Item = {
      sourceUrl,
      product_id: rawDetails.productIdAttribute || sourceUrl.split('/').filter(Boolean).pop() || 'unknown-product-id',
      title: rawDetails.title,
      description: rawDetails.descriptionHTML, // Storing HTML description for now
      images,
      price: price !== undefined ? price : 0,
      currency,
      tags, // Added tags from additional information
      // sale_price, vendor, type, rating, num_ratings, color, sizes, variants, similar_item_urls, status
    };

    // return [Utils.formatItem(item)]; // Uncomment when Utils is confirmed and imported
    return item; // Returning raw item for now

  } catch (error) {
    log.error(`Error scraping item from ${sourceUrl}:`, error);
    const parts = sourceUrl.split('/').filter(Boolean);
    const productId = parts.pop() || 'unknown-product-id';
    return { // Return a default/error item structure
      sourceUrl,
      product_id: productId,
      title: 'Error Scraping Item',
      images: [],
      price: 0,
      currency: 'EUR',
      description: `Failed to scrape: ${(error as Error).message}`
    };
  } finally {
    // if (browser) { // Browser lifecycle managed by the caller
    //   await browser.close();
    // }
  }
};

const formiScraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem,
};

export { formiScraper, startUrl };
export default formiScraper; // Added default export 