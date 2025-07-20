import type { Page } from 'playwright';
// import playwright from 'playwright'; // Removed playwright import, chromium/Browser will be managed by caller
import type { Item, Image } from '../types/item.js';
import type { Scraper } from './types.js';
import { formatItem } from '../db/db-utils.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import { logger } from '../utils/logger.js';

const domain = 'nazarelli.store';
const log = logger.createContext('nazarelli.store');

export async function getItemUrls(page: Page): Promise<Set<string>> {
  await page.waitForSelector('ul.products li.product a.woocommerce-LoopProduct-link', { state: 'attached', timeout: 10000 });

  const urls = await page.evaluate(() => {
    const productLinks = Array.from(document.querySelectorAll('ul.products li.product a.woocommerce-LoopProduct-link'));
    return productLinks.map(link => (link as HTMLAnchorElement).href);
  });

  return new Set(urls.map(url => new URL(url, page.url()).href));
}

export async function paginate(page: Page): Promise<boolean> {
  const nextPageSelector = 'a.next.page-numbers';
  const elementorPopupSelector = 'div#elementor-popup-modal-2142';
  const ajaxLoaderSelector = 'div.bapf_loader_page'; // Loader identified from logs
  const closeButtonSelectors = [
    `${elementorPopupSelector} button[aria-label*="Close"]`,
    `${elementorPopupSelector} .dialog-close-button`,
    `${elementorPopupSelector} .elementor-popup-modal__close`,
    `${elementorPopupSelector} button`
  ];

  try {
    // Check for and close the Elementor popup if it appears
    const isPopupVisible = await page.isVisible(elementorPopupSelector, { timeout: 3000 }).catch(() => false);
    if (isPopupVisible) {
      log.debug('Elementor popup detected. Attempting to close...');
      for (const selector of closeButtonSelectors) {
        const closeButton = await page.$(selector);
        if (closeButton && await closeButton.isVisible()) {
          await closeButton.click({ force: true });
          log.debug(`Clicked Elementor popup close button with selector: ${selector}`);
          await page.waitForSelector(elementorPopupSelector, { state: 'hidden', timeout: 5000 })
            .catch(() => log.debug('Elementor popup did not disappear after click or timed out.'));
          break;
        }
      }
      await page.waitForTimeout(500); // Brief pause for DOM to settle after popup close
    }

    // Wait for AJAX loader (if present) to disappear before proceeding
    const isLoaderVisible = await page.isVisible(ajaxLoaderSelector, { timeout: 1000 }).catch(() => false);
    if (isLoaderVisible) {
      log.debug('AJAX loader detected. Waiting for it to disappear...');
      await page.waitForSelector(ajaxLoaderSelector, { state: 'hidden', timeout: 10000 })
        .catch(() => log.debug('AJAX loader did not disappear within timeout.'));
      await page.waitForTimeout(500); // Brief pause after loader disappears
    }

    const nextPageLink = await page.$(nextPageSelector);
    if (nextPageLink) {
      log.debug('Attempting to click next page link...');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }), // Increased navigation timeout slightly
        nextPageLink.click(),
      ]);
      log.debug('Navigation triggered. Verifying next page content...');
      await page.waitForSelector('ul.products li.product a.woocommerce-LoopProduct-link', { state: 'attached', timeout: 10000 });
      log.debug('Next page content verified.');
      return true;
    }
    log.debug('No next page link found.');
    return false;

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.debug(`Pagination error or end of pages: ${message}`);
    return false;
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
    // waitUntil: 'networkidle' might still be important, the caller of scrapeItem should ensure this if needed before calling.
    await page.waitForSelector('div.product[id^="product-"]'); // Wait for main product container

    const rawDetails = await page.evaluate(() => {
      const productElement = document.querySelector('div.product[id^="product-"]');
      const productId = productElement ? productElement.id.replace('product-', '') : '';

      const title = document.querySelector('h1.product_title')?.textContent?.trim() || '';
      const priceText = document.querySelector('p.price .woocommerce-Price-amount bdi')?.textContent?.trim() || null;
      const currencySymbol = document.querySelector('p.price .woocommerce-Price-currencySymbol')?.textContent?.trim() || null;

      const shortDescription = document.querySelector('.woocommerce-product-details__short-description')?.innerHTML.trim() || '';

      let fullDescription = '';
      const descriptionTabPanel = document.querySelector('#tab-description');
      if (descriptionTabPanel) {
        const h2Title = descriptionTabPanel.querySelector('h2'); // WooCommerce often adds a h2 title to the tab
        if (h2Title && h2Title.textContent?.toLowerCase().includes('опис')) {
          // If h2 is 'Опис', take siblings or all content minus h2
          let content = '';
          descriptionTabPanel.childNodes.forEach(node => {
            if (node !== h2Title) {
              content += node.textContent?.trim() + '\n';
            }
          });
          fullDescription = content.trim();
        } else {
          fullDescription = descriptionTabPanel.innerHTML.trim(); // Fallback to innerHTML if no obvious title or structure
        }
      }

      const imageElements = Array.from(document.querySelectorAll('#commercegurus-pdp-gallery .cg-main-swiper .swiper-slide a.swiper-slide-imglink'));
      const images = imageElements.map(link => {
        const imgElement = link.querySelector('img');
        return {
          src: (link as HTMLAnchorElement).href, // High-res from link
          alt: imgElement?.getAttribute('alt')?.trim() || title,
        };
      }).filter(img => img.src); // Ensure src is present

      const variationsJson = document.querySelector('form.variations_form')?.getAttribute('data-product_variations') || '[]';

      return {
        productId,
        title,
        priceText,
        currencySymbol,
        shortDescription,
        fullDescription,
        images,
        variationsJson,
      };
    });

    const parsePrice = (text: string | null): number | undefined => {
      if (!text) return undefined;
      const cleanedText = text
        .replace(/грн/gi, '')
        .replace(/\s|\u00A0/g, '')
        .trim();

      let numericString = cleanedText.replace(/,/g, ''); // Remove commas (potential thousand separators)

      if (/^\d+$/.test(numericString)) { // Corrected regex for whole number
        return parseFloat(numericString);
      }

      // Fallback if not a simple whole number (e.g. if original was "6.50" or had a period decimal)
      numericString = cleanedText.replace(',', '.'); // Ensure decimal is a dot for other cases
      if (/^\d*\.?\d+$/.test(numericString)) { // Corrected regex for float
        return parseFloat(numericString);
      }

      log.debug(`Could not reliably parse price from text: "${text}" -> "${cleanedText}" -> attempts based on removing/replacing comma: "${cleanedText.replace(/,/g, '')}" or "${cleanedText.replace(',', '.')}"`);
      return undefined;
    };

    const price = parsePrice(rawDetails.priceText);
    let currency = rawDetails.currencySymbol || 'UAH';
    if (currency === 'грн') {
      currency = 'UAH';
    }

    const description = [rawDetails.shortDescription, rawDetails.fullDescription].filter(Boolean).join('\n\n').replace(/<[^>]*>/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); // Clean up HTML and extra newlines

    let sizes: { size: string; is_available: boolean }[] = [];
    try {
      const variations = JSON.parse(rawDetails.variationsJson);
      if (variations && Array.isArray(variations)) {
        variations.forEach((variation: any) => {
          const sizeAttribute = variation.attributes?.attribute_pa_rozmir;
          if (sizeAttribute && typeof sizeAttribute === 'string' && sizeAttribute.trim() !== '') {
            sizes.push({
              size: sizeAttribute.toUpperCase(),
              is_available: variation.is_in_stock === true,
            });
          }
        });
      }
    } catch (e) {
      log.debug(`Could not parse variations JSON for ${sourceUrl}. Will attempt to get sizes from buttons. Error: ${e instanceof Error ? e.message : String(e)}`);
      sizes = [];
    }

    if (sizes.length === 0) {
      const evalResult = await page.$$eval('ul.cgkit-attribute-swatches button[data-attribute-value]', buttons => {
        const debugLogsInternal: string[] = [];
        const buttonData = buttons.map(btn => {
          const rawValue = (btn as HTMLButtonElement).dataset.attributeValue;
          return {
            size: rawValue?.toUpperCase() || '',
            is_available: !btn.classList.contains('disabled') && !btn.classList.contains('cgkit-disabled')
          };
        });
        return { buttonData, debugLogs: debugLogsInternal };
      }).catch(err => {
        log.debug(`[Node] Error during page.$$eval for size buttons for ${sourceUrl}:`, err);
        return { buttonData: [], debugLogs: [`[Node] Error in $$eval for ${sourceUrl}: ${err instanceof Error ? err.message : String(err)}`] };
      });

      if (evalResult.buttonData.length > 0) {
        sizes = evalResult.buttonData.filter(s => s.size);
      }
    }

    if (sizes.length === 0) {
      log.debug(`No sizes found for ${sourceUrl} from variations JSON or buttons.`);
    }

    // Image handling with existing images support
    let finalImages: Image[];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
      log.debug(`Using ${options.existingImages.length} existing images from database`);
      finalImages = options.existingImages.map(img => ({
        sourceUrl: img.sourceUrl,
        mushUrl: img.mushUrl,
        alt_text: undefined
      }));
    } else {
      // Note: This scraper doesn't currently upload to S3
      finalImages = rawDetails.images.map(img => ({
        sourceUrl: img.src,
        alt_text: img.alt,
      }));
      // TODO: Implement S3 upload with uploadImagesToS3AndAddUrls
    }

    const item: Item = {
      sourceUrl,
      product_id: rawDetails.productId || 'placeholder-id',
      title: rawDetails.title,
      price: price ?? 0,
      currency,
      description: description || undefined,
      images: finalImages.length > 0 ? finalImages : [],
      sizes: sizes.length > 0 ? sizes : undefined,
    };

    return formatItem(item);
  } finally {
    // await browser.close(); // Browser lifecycle managed by the caller
  }
}

const scraper: Scraper = {
  getItemUrls,
  paginate,
  scrapeItem,
};

export default scraper; 