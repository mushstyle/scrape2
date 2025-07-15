import { Page } from 'playwright';
import { Item, Size, Image } from '../types/item.js';
import * as Utils from '../db/db-utils.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import type { Scraper } from './types.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('keepstyle.co');

export const SELECTORS = {
  productGrid: '#CollectionProductGrid div.m-collection-products', // Container for all product cards
  productLinks: 'div.m-product-item a.m-product-card__link', // Links to product pages
  loadMoreButton: 'div.m-collection--pagination > button[data-load-more]', // "Load more" button
  product: {
    container: 'div.m-main-product--info', // Main container for product details on item page
    title: 'h1.m-product-title', // Product title element
    price: {
      price_container: 'div.main-product__block-price span.m-price-item--regular', // For regular price
      old: 'div.main-product__block-price s.m-price-item--regular',    // For old price when on sale
      sale: 'div.main-product__block-price span.m-price-item--sale',     // For sale price
    },
    images: {
      container: 'div.m-product-media--slider__images img', // Container for main product images
      sourceUrl: 'src',
      alt: 'alt'
    },
    productId: {
      // SKU is present in a script tag with type="application/json" and id="productVariants"
      // Will need to parse this JSON
      selector: 'script#productVariants', // The script tag containing variant data
      attribute: '' // Not using an attribute, will use textContent and parse JSON
    },
    description: 'div[data-block-id="collapsible-tab-collapsible_tab_eJUQwU"] div.rte', // Description in the first collapsible tab
    sizes: {
      // Sizes are radio buttons
      container: 'div.m-product-option--button[data-option-name="Розмір"] input[type="radio"]',
      label: 'value', // The value attribute holds the size name
    }
  },
};

export async function getItemUrls(page: Page): Promise<Set<string>> {
  await page.waitForSelector(SELECTORS.productGrid, { timeout: 10000 });

  const urls = await page.evaluate((productLinkSelector) => {
    const productLinks = document.querySelectorAll(productLinkSelector);
    const uniqueUrls = new Set<string>();
    const base = (document.querySelector('base') as HTMLBaseElement)?.href || window.location.origin;

    productLinks.forEach(link => {
      const href = (link as HTMLAnchorElement).href;
      if (href) {
        uniqueUrls.add(new URL(href, base).href);
      }
    });
    return [...uniqueUrls];
  }, SELECTORS.productLinks);

  return new Set(urls);
}


let currentPage = 1;
let totalPages = -1; // Initialize with -1 to fetch on first run

async function getTotalPages(page: Page): Promise<number> {
  if (totalPages === -1) { // Fetch only once
    const productContainer = await page.$(SELECTORS.productGrid);
    if (productContainer) {
      const totalPagesAttr = await productContainer.getAttribute('data-total-pages');
      totalPages = totalPagesAttr ? parseInt(totalPagesAttr, 10) : 1;
      log.debug(`   Pagination: Total pages identified: ${totalPages}`);
    } else {
      log.debug(`   Pagination: Product grid '${SELECTORS.productGrid}' not found. Assuming single page.`);
      totalPages = 1; // Fallback if not found
    }
  }
  return totalPages;
}

// Helper function for scroll-based pagination logic
async function scrollPaginateInternal(page: Page, totalPgs: number, initialProductCountOverride?: number): Promise<boolean> {
  log.debug(`   Pagination (Scroll): Attempting to scroll. Current page: ${currentPage}, Total: ${totalPgs}`);
  const productCountBeforeScroll = initialProductCountOverride ?? await page.$$eval(SELECTORS.productLinks, links => links.length).catch(() => 0);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  try {
    await page.waitForFunction(
      (data: { sel: string; count: number }) => {
        const currentElements = document.querySelectorAll(data.sel);
        return currentElements.length > data.count;
      },
      { sel: SELECTORS.productLinks, count: productCountBeforeScroll }, // Pass arguments as a single object
      { polling: 100, timeout: 10000 } // Poll every 100ms
    );
    const productCountAfterScroll = await page.$$eval(SELECTORS.productLinks, links => links.length);
    log.debug(`   Pagination (Scroll): New products loaded. Prev count: ${productCountBeforeScroll}, New count: ${productCountAfterScroll}.`);
    currentPage++;
    return true;
  } catch (waitError) {
    log.debug(`   Pagination (Scroll): Scrolled, but no new products detected or timed out waiting. Error: ${(waitError as Error).message}`);
    currentPage++; // Increment page as an attempt was made
    return false; // No new items after scroll
  }
}

export async function paginate(page: Page): Promise<boolean> {
  const total = await getTotalPages(page);

  if (currentPage >= total) {
    log.debug(`   Pagination: Reached declared last page (${currentPage}/${total}). No next page.`);
    return false;
  }

  // Attempt to close popups before interacting with pagination elements
  try {
    const klaviyoPopupSelector = 'div[role="dialog"][aria-modal="true"][aria-label="POPUP Form"]';
    const klaviyoCloseButtonSelectors = [
      `${klaviyoPopupSelector} button[aria-label*="Close"]`,
      `${klaviyoPopupSelector} button[aria-label*="close"]`,
      `${klaviyoPopupSelector} [class*="close"]`, // General class-based close
      `${klaviyoPopupSelector} [data-testid*="close"]`,
      `${klaviyoPopupSelector} a[href="#close"]`, // Link based close
      'button.klaviyo-close-form', // More specific if known
      'button[aria-label="close popup"]'
    ];

    let closedByButton = false;
    for (const selector of klaviyoCloseButtonSelectors) {
      const closeButton = await page.$(selector);
      if (closeButton && await closeButton.isVisible()) {
        log.debug(`   Pagination: Popup detected (selector: ${selector}). Attempting to click close button.`);
        await closeButton.click({ timeout: 3000 }).catch(e => log.debug(`   Pagination: Non-critical error clicking popup close button (${selector}): ${(e as Error).message}`));
        await page.waitForTimeout(500); // Brief pause
        // Verify popup is gone
        const stillVisible = await page.$(selector).then(btn => btn && btn.isVisible()).catch(() => false);
        if (!stillVisible) {
          closedByButton = true;
          log.debug(`   Pagination: Popup closed successfully with selector: ${selector}`);
          break;
        } else {
          log.debug(`   Pagination: Clicked close button (${selector}), but popup seems to persist.`);
        }
      }
    }

    if (!closedByButton) {
      const activePopup = await page.$(klaviyoPopupSelector);
      if (activePopup && await activePopup.isVisible()) {
        log.debug("   Pagination: Popup still detected. Attempting to dismiss with Escape key.");
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500); // Brief pause after escape
        const stillVisibleAfterEscape = await activePopup.isVisible().catch(() => false);
        if (!stillVisibleAfterEscape) {
          log.debug("   Pagination: Popup dismissed with Escape key.");
        } else {
          log.debug("   Pagination: Popup persists after Escape key attempt.");
        }
      }
    }
  } catch (popupError) {
    log.debug(`   Pagination: Error trying to handle popup: ${(popupError as Error).message}`);
  }
  // End of popup handling

  try {
    const loadMoreButton = await page.$(SELECTORS.loadMoreButton);

    if (loadMoreButton) {
      const isVisible = await loadMoreButton.isVisible().catch(() => false);
      const isDisabled = await loadMoreButton.isDisabled().catch(() => true);

      if (isVisible && !isDisabled) {
        log.debug(`   Pagination (Button): Clicking "Load More". Current page: ${currentPage}, Total: ${total}`);
        const initialProductCount = await page.$$eval(SELECTORS.productLinks, links => links.length).catch(() => 0);

        await loadMoreButton.scrollIntoViewIfNeeded().catch(e => log.debug("   Pagination (Button): Failed to scroll 'Load More' into view:", (e as Error).message));
        await page.waitForTimeout(250); // Brief pause allowing UI to settle after scroll

        try {
          await loadMoreButton.click({ timeout: 10000 }); // Increased timeout for click action
        } catch (clickError) {
          log.error(`   Pagination (Button): Error clicking "Load More": ${(clickError as Error).message}. Attempting scroll fallback.`);
          return await scrollPaginateInternal(page, total, initialProductCount);
        }

        try {
          await page.waitForFunction(
            (data: { sel: string; count: number }) => document.querySelectorAll(data.sel).length > data.count,
            { sel: SELECTORS.productLinks, count: initialProductCount }, // Pass arguments as a single object
            { polling: 100, timeout: 10000 } // Poll every 100ms
          );
          const newProductCount = await page.$$eval(SELECTORS.productLinks, links => links.length);
          log.debug(`   Pagination (Button): New products loaded. Prev count: ${initialProductCount}, New count: ${newProductCount}.`);
          currentPage++;
          return true;
        } catch (waitError) {
          log.debug(`   Pagination (Button): Clicked, but no new products detected or timed out. Prev count: ${initialProductCount}. Error: ${(waitError as Error).message}`);
          const stillVisibleAfterWait = await loadMoreButton.isVisible().catch(() => false);
          const stillEnabledAfterWait = !await loadMoreButton.isDisabled().catch(() => true);
          if (!stillVisibleAfterWait || !stillEnabledAfterWait) {
            log.debug("   Pagination (Button): 'Load More' no longer interactable. Assuming end of button pagination.");
            currentPage++; // Attempt was made
            return false;
          }
          log.debug("   Pagination (Button): Click didn't load items, button still present. Attempting scroll fallback.");
          return await scrollPaginateInternal(page, total, initialProductCount);
        }
      } else if (!isVisible) {
        log.debug(`   Pagination: "Load More" button found but not visible. Proceeding to scroll.`);
      } else if (isDisabled) {
        log.debug(`   Pagination: "Load More" button found but disabled. Assuming end of button pagination.`);
        return false;
      }
    } else {
      log.debug(`   Pagination: "Load More" button ('${SELECTORS.loadMoreButton}') not found. Proceeding to scroll.`);
    }

    // Scroll pagination as fallback or if no button
    return await scrollPaginateInternal(page, total);

  } catch (error) {
    log.error(`   Pagination: Main error during pagination attempt: ${(error as Error).message}`);
    return false;
  }
}


export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item> {
  const sourceUrl = page.url();
  log.debug(`   Scraping item: ${sourceUrl}`);
  try {
    await page.waitForSelector(SELECTORS.product.container, { timeout: 10000 });

    const title = await page.$eval(SELECTORS.product.title, el => el.textContent?.trim() || 'Unknown Product').catch(() => 'Unknown Product');

    // Product ID / SKU from JSON
    let vendorCode = '';
    let variantsData: any[] = [];
    try {
      const productVariantsJson = await page.$eval(SELECTORS.product.productId.selector, el => el.textContent);
      if (productVariantsJson) {
        variantsData = JSON.parse(productVariantsJson);
        if (variantsData.length > 0 && variantsData[0].sku) {
          vendorCode = variantsData[0].sku; // Use SKU of the first variant as product_id
        } else if (variantsData.length > 0 && variantsData[0].id) {
          vendorCode = String(variantsData[0].id); // Fallback to variant id if SKU not present
        }
      }
    } catch (e) {
      log.debug(`   Could not parse product variants JSON for ${sourceUrl}: ${(e as Error).message}`);
    }
    if (!vendorCode) {
      vendorCode = sourceUrl.split('/').pop()?.split('?')[0] || ''; // Fallback from URL
    }


    const description = await page.$eval(SELECTORS.product.description, el => el.innerHTML.trim() || '').catch(() => '');

    // Price scraping
    let price = 0;
    let salePrice: number | undefined;
    let currency = 'USD'; // Defaulting to USD

    try {
      // Selectors based on your SELECTORS object
      const oldPriceSelector = SELECTORS.product.price.old; // e.g., s.m-price-item--regular (strikethrough original price)
      const currentDisplayPriceSelector = SELECTORS.product.price.sale; // e.g., span.m-price-item--sale (current price if on sale, or main price)
      const regularPriceFallbackSelector = SELECTORS.product.price.price_container; // e.g., span.m-price-item--regular (not in <s>)

      const oldPriceText = await page.$eval(oldPriceSelector, el => el.textContent?.trim() || null).catch(() => null);
      const currentDisplayPriceText = await page.$eval(currentDisplayPriceSelector, el => el.textContent?.trim() || null).catch(() => null);
      const regularPriceFallbackText = await page.$eval(regularPriceFallbackSelector, el => el.textContent?.trim() || null).catch(() => null);

      const extractPriceVal = (text: string | null): number | undefined => {
        if (!text || text.trim() === '') return undefined;
        // For formats like "2 940 ₴" or "$105.50":
        // 1. Remove all spaces to handle thousands separators like "2 940" -> "2940".
        // 2. Remove all characters that are not digits or a decimal point.
        const cleanedText = text
          .replace(/\s/g, '') // Remove all spaces
          .replace(/[^\d.]/g, ''); // Remove all non-digits and non-periods

        if (cleanedText === '') return undefined;
        const num = parseFloat(cleanedText);
        return isNaN(num) ? undefined : num;
      };

      const anyPriceTextForCurrency = currentDisplayPriceText || oldPriceText || regularPriceFallbackText;
      if (anyPriceTextForCurrency) {
        const currencyMatch = anyPriceTextForCurrency.match(/(?:[A-Z]{3})|[^0-9.,\s\d]+/);
        if (currencyMatch && currencyMatch[0]) {
          const symbolOrCode = currencyMatch[0].toUpperCase();
          if (symbolOrCode === '$' || symbolOrCode === 'USD') currency = 'USD';
          else if (symbolOrCode === '₴' || symbolOrCode === 'UAH') currency = 'UAH';
          else if (symbolOrCode === '€' || symbolOrCode === 'EUR') currency = 'EUR';
          // Add other currency mappings if needed
        }
      }

      const parsedOldPrice = extractPriceVal(oldPriceText);
      const parsedCurrentDisplayPrice = extractPriceVal(currentDisplayPriceText);
      const parsedRegularFallbackPrice = extractPriceVal(regularPriceFallbackText);

      if (parsedOldPrice !== undefined && parsedOldPrice > 0) {
        // Case 1: Strikethrough old price found - item might be on sale.
        price = parsedOldPrice;
        if (parsedCurrentDisplayPrice !== undefined && parsedCurrentDisplayPrice < parsedOldPrice) {
          salePrice = parsedCurrentDisplayPrice;
        } else {
          // Old price present, but current display price is not less (or missing). Not a clear sale.
          salePrice = undefined;
          if (parsedCurrentDisplayPrice !== undefined && parsedCurrentDisplayPrice >= parsedOldPrice) {
            log.debug(`   Sale structure anomaly: Old price ${parsedOldPrice} ${currency} found, but current display price ${parsedCurrentDisplayPrice} ${currency} is not lower. URL: ${sourceUrl}`);
          }
        }
      } else {
        // Case 2: No valid strikethrough old price. Item is not on sale.
        // Price is the current display price or the regular fallback.
        // The currentDisplayPriceSelector (span.m-price-item--sale) might hold the actual price on non-sale items for this theme.
        if (parsedCurrentDisplayPrice !== undefined) {
          price = parsedCurrentDisplayPrice;
        } else if (parsedRegularFallbackPrice !== undefined) {
          price = parsedRegularFallbackPrice;
        } else {
          price = 0; // Fallback if no prices found
        }
        salePrice = undefined;
      }

      // If price ended up as undefined or 0 from the logic above, and there were parseable values, try to assign something.
      if ((price === 0 || price === undefined) && (parsedCurrentDisplayPrice !== undefined || parsedRegularFallbackPrice !== undefined)) {
        if (parsedCurrentDisplayPrice !== undefined && parsedCurrentDisplayPrice > 0) price = parsedCurrentDisplayPrice;
        else if (parsedRegularFallbackPrice !== undefined && parsedRegularFallbackPrice > 0) price = parsedRegularFallbackPrice;
        // If it's still 0, it means the texts parsed to 0.
      }

      if (price === 0 || price === undefined) {
        log.debug(`   Price could not be determined or is zero for ${sourceUrl}. Review selectors and page structure. Price texts: Old='${oldPriceText}', CurrentDisplay='${currentDisplayPriceText}', RegularFallback='${regularPriceFallbackText}'`);
        price = 0; // Ensure price is a number for the Item type
      }

    } catch (e) {
      log.debug(`   Price scraping error for ${sourceUrl}: ${(e as Error).message}`);
      price = 0; // Ensure price is a number in case of error
      salePrice = undefined;
    }


    const imagesData: { sourceUrl: string; alt_text: string }[] = await page.$$eval(
      SELECTORS.product.images.container, // 'div.m-product-media--slider__images img'
      (imageElements, data) => { // data = { productTitle, urlAttr: 'src', altAttr: 'alt' }
        const collectedImages: { sourceUrl: string; alt_text: string }[] = [];
        const uniqueUrls = new Set<string>();

        imageElements.forEach((img: Element) => {
          let imageUrl: string | null = null;

          // Prioritize specific data attributes that often hold larger/main images
          imageUrl = img.getAttribute('data-zoom-src') ||
            img.getAttribute('data-large-src') ||
            img.getAttribute('data-full-src') ||
            img.getAttribute('data-src') ||       // Common for lazy-loaded images
            img.getAttribute(data.urlAttr) ||     // Original 'src' attribute (SELECTORS.product.images.url)
            null;

          // Fallback to srcset, trying to get a decent resolution
          if (!imageUrl) {
            const srcset = img.getAttribute('data-srcset') || img.getAttribute('srcset');
            if (srcset) {
              const sources = srcset.split(',').map(s => {
                const parts = s.trim().split(/\s+/);
                return { sourceUrl: parts[0], width: parseInt(parts[1]?.replace('w', ''), 10) || 0 };
              });
              if (sources.length > 0) {
                sources.sort((a, b) => b.width - a.width); // Sort by width descending
                if (sources[0].sourceUrl) imageUrl = sources[0].sourceUrl; // Pick the widest
              }
            }
          }

          // If the img is a child of an <a> tag, and the <a> tag's href is an image, 
          // prefer that if current imageUrl is tiny/thumbnail-like or missing.
          const parentAnchor = img.closest('a');
          if (parentAnchor) {
            const anchorHref = parentAnchor.getAttribute('href');
            // Check if href is a valid image URL and not a javascript or anchor link
            if (anchorHref && /\.(jpeg|jpg|gif|png|webp)(\?|$)/i.test(anchorHref) &&
              !anchorHref.startsWith('#') && !anchorHref.toLowerCase().startsWith('javascript:')) {
              // Prefer anchor if no imageUrl yet, or if current imageUrl seems like a placeholder/thumbnail
              if (!imageUrl || (imageUrl && (imageUrl.includes('thumb') || imageUrl.includes('icon') || imageUrl.includes('placeholder') || /_small\.|_thumb\.|_pico\.|_icon\.|_compact\./.test(imageUrl)))) {
                imageUrl = anchorHref;
              }
            }
          }

          if (imageUrl) {
            if (imageUrl.startsWith('//')) {
              imageUrl = 'https:' + imageUrl;
            }
            try {
              // Normalize URL by removing common tracking/sizing params before uniqueness check
              const urlObj = new URL(imageUrl, document.baseURI);
              const paramsToRemove = ['v', 'width', 'height', 'size', 'format', 'quality', 'fit', 'crop', 'expires', 'signature', 'alt'];
              paramsToRemove.forEach(param => urlObj.searchParams.delete(param));
              imageUrl = urlObj.href;
            } catch (e) {
              imageUrl = null; // Invalidate if it cannot be resolved
            }
          }

          if (imageUrl && !uniqueUrls.has(imageUrl)) {
            uniqueUrls.add(imageUrl);
            collectedImages.push({
              sourceUrl: imageUrl,
              alt_text: img.getAttribute(data.altAttr)?.trim() || data.productTitle
            });
          }
        });
        return collectedImages;
      },
      { productTitle: title, urlAttr: SELECTORS.product.images.sourceUrl, altAttr: SELECTORS.product.images.alt }
    ).catch((e) => {
      log.debug(`   Error evaluating images for ${sourceUrl}: ${(e as Error).message}`);
      return [];
    });

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

        imagesWithMushUrl = await uploadImagesToS3AndAddUrls(imagesData, sourceUrl);

      } else {

        // Skip S3 upload, just use scraped images with sourceUrl only

        imagesWithMushUrl = imagesData;

      }
    }

    let sizes: Size[] = [];
    try {
      // Attempt 1: Extract sizes from productVariants JSON (variantsData)
      if (variantsData && variantsData.length > 0) {
        const sizeOptionKey = variantsData[0]?.option1 ? 'option1' : (variantsData[0]?.option2 ? 'option2' : (variantsData[0]?.option3 ? 'option3' : null));

        if (sizeOptionKey) {
          const uniqueSizes = new Set<string>();
          variantsData.forEach(variant => {
            if (variant[sizeOptionKey]) {
              uniqueSizes.add(String(variant[sizeOptionKey]).trim());
            }
          });

          sizes = Array.from(uniqueSizes).map(sizeValue => {
            const relevantVariant = variantsData.find(v => v[sizeOptionKey] === sizeValue);
            return {
              size: sizeValue,
              is_available: relevantVariant ? relevantVariant.available : false,
            };
          }).filter(s => s.size);
        }
      }

      // Attempt 2: Fallback to DOM extraction if JSON didn't yield sizes
      if (sizes.length === 0) {
        log.debug(`   Sizes not found in JSON, attempting DOM extraction for ${sourceUrl}`);
        const sizeOptionContainerSelector = 'div.m-product-option--button[data-option-name="Розмір"]';
        await page.waitForSelector(sizeOptionContainerSelector, { timeout: 10000 });

        // Get size values from labels or input values if labels aren't specific enough
        const availableSizes = await page.$$eval(`${sizeOptionContainerSelector} .m-product-option--node`, (nodes) => {
          return nodes.map(node => {
            const inputElement = node.querySelector('input[type="radio"]') as HTMLInputElement;
            const labelElement = node.querySelector('label');
            const sizeValue = inputElement?.value?.trim() || labelElement?.textContent?.trim() || '';

            // Check availability by looking if the input is disabled, or if a specific class indicating "sold out" exists
            // This might need site-specific adjustment
            let isAvailable = inputElement ? !inputElement.disabled : true;
            if (node.classList.contains('sold-out') || node.classList.contains('unavailable')) { // Example classes
              isAvailable = false;
            }

            return {
              size: sizeValue,
              is_available: isAvailable,
            };
          }).filter(s => s.size);
        });
        sizes = availableSizes;

        // Re-check availability with variantsData if it exists, as it's more reliable
        if (variantsData.length > 0 && sizes.length > 0) {
          const sizeOptionKey = variantsData[0]?.option1 ? 'option1' : (variantsData[0]?.option2 ? 'option2' : (variantsData[0]?.option3 ? 'option3' : null));
          if (sizeOptionKey) {
            sizes = sizes.map(s => {
              const variantInfo = variantsData.find(v => v[sizeOptionKey] === s.size);
              return {
                ...s,
                is_available: variantInfo ? variantInfo.available : s.is_available,
              };
            });
          }
        }
      }

      if (sizes.length === 0) {
        log.debug(`   Sizes not found for ${sourceUrl} after both JSON and DOM attempts.`);
      }

    } catch (e) {
      log.debug(`   Error during size extraction for ${sourceUrl}: ${(e as Error).message}`);
    }

    const finalItem: Item = {
      sourceUrl,
      product_id: vendorCode,
      title,
      description,
      images: imagesWithMushUrl,
      price,
      sale_price: salePrice,
      currency,
      sizes: sizes.length > 0 ? sizes : undefined,
      vendor: 'keepstyle',
      status: sizes.length > 0 ? (sizes.some(s => s.is_available) ? 'ACTIVE' : 'DELETED') : 'ACTIVE',
      tags: []
    };

    return Utils.formatItem(finalItem);

  } catch (error) {
    log.error(`Error scraping item at ${sourceUrl}: `, error);
    throw error;
  }
}

const scraper: Scraper = {
  getItemUrls,
  paginate,
  scrapeItem
};

export default scraper; 