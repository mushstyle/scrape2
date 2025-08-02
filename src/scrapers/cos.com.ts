import type { Page } from 'playwright';
import type { Item, Image, Size } from '../types/item.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import { formatItem } from '../db/db-utils.js';
import { logger } from '../utils/logger.js';

const DOMAIN = 'cos.com';
const log = logger.createContext('cos.com');

// Helper function to detect and close overlays (email capture, shipping confirmation, etc.)
async function handleOverlays(page: Page): Promise<boolean> {
  let anyOverlayHandled = false;
  
  try {
    // 1. Handle shipping country confirmation modal first
    const shippingModalButton = page.locator('button[data-testid="shipping-country-confirmation-modal-continue-to-current-market-btn"]');
    if (await shippingModalButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      log.debug('Shipping country confirmation modal detected, clicking "Yes, continue"...');
      await shippingModalButton.click();
      await page.waitForTimeout(1000);
      anyOverlayHandled = true;
    }
    
    // 2. Handle Attentive overlay (iframe-based) - more aggressive approach
    const attentiveOverlay = await page.locator('#attentive_overlay').isVisible({ timeout: 500 }).catch(() => false);
    const attentiveCreative = await page.locator('#attentive_creative').isVisible({ timeout: 500 }).catch(() => false);
    
    if (attentiveOverlay || attentiveCreative) {
      log.debug('Attentive overlay detected, attempting to dismiss...');
      
      // Try Escape key first
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      
      // Always remove it via JavaScript (more aggressive)
      await page.evaluate(() => {
        // Remove the overlay completely
        const attentive = document.querySelector('#attentive_overlay');
        if (attentive) {
          attentive.remove();
        }
        // Also remove the creative iframe
        const attentiveCreative = document.querySelector('#attentive_creative');
        if (attentiveCreative) {
          attentiveCreative.remove();
        }
        // Remove any parent containers that might be blocking
        const attentiveParent = document.querySelector('[id*="attentive"]');
        if (attentiveParent && attentiveParent.id !== 'attentive_overlay' && attentiveParent.id !== 'attentive_creative') {
          attentiveParent.remove();
        }
      });
      log.debug('Forcefully removed Attentive overlay');
      anyOverlayHandled = true;
    }
    
    // 3. Check for the email capture overlay
    const overlayExists = await page.locator('#contentframe').isVisible({ timeout: 1000 }).catch(() => false);
    
    if (overlayExists) {
      log.debug('Email capture overlay detected, attempting to dismiss...');
      
      // First try: Press Escape key (most common way to close modals)
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
      
      // Check if overlay is gone
      let stillVisible = await page.locator('#contentframe').isVisible({ timeout: 500 }).catch(() => false);
      
      if (!stillVisible) {
        log.debug('Successfully dismissed overlay with Escape key');
        return true;
      }
      
      // Second try: Click outside the overlay content
      // The overlay has a content div with id="content", so we click outside it
      try {
        // Get the bounding box of the content area
        const contentBox = await page.locator('#content').boundingBox();
        if (contentBox) {
          // Click to the left of the content (in the overlay backdrop area)
          await page.mouse.click(contentBox.x - 50, contentBox.y + contentBox.height / 2);
          await page.waitForTimeout(1000);
          
          stillVisible = await page.locator('#contentframe').isVisible({ timeout: 500 }).catch(() => false);
          if (!stillVisible) {
            log.debug('Successfully dismissed overlay by clicking outside content');
            return true;
          }
        }
      } catch (e) {
        log.debug('Could not click outside content box');
      }
      
      // Third try: Click in the corners (sometimes overlays have invisible close areas)
      const clickPositions = [
        { x: 10, y: 10 },                    // Top-left
        { x: page.viewportSize()?.width ? page.viewportSize()!.width - 10 : 1910, y: 10 }, // Top-right
      ];
      
      for (const pos of clickPositions) {
        await page.mouse.click(pos.x, pos.y);
        await page.waitForTimeout(500);
        
        stillVisible = await page.locator('#contentframe').isVisible({ timeout: 500 }).catch(() => false);
        if (!stillVisible) {
          log.debug(`Successfully dismissed overlay by clicking at (${pos.x}, ${pos.y})`);
          return true;
        }
      }
      
      // Fourth try: Look for any close buttons that might not have been caught by selectors
      // Sometimes close buttons are SVGs or have no text
      const possibleCloseButtons = await page.locator('button, [role="button"], [aria-label*="close" i], [aria-label*="dismiss" i]').all();
      
      for (const button of possibleCloseButtons) {
        try {
          const box = await button.boundingBox();
          if (box && box.y < 100) { // Close buttons are usually at the top
            await button.click({ timeout: 1000 });
            await page.waitForTimeout(500);
            
            stillVisible = await page.locator('#contentframe').isVisible({ timeout: 500 }).catch(() => false);
            if (!stillVisible) {
              log.debug('Successfully dismissed overlay with close button');
              return true;
            }
          }
        } catch (e) {
          // Continue to next button
        }
      }
      
      // Final try: Force remove the overlay via JavaScript
      try {
        await page.evaluate(() => {
          const overlay = document.querySelector('#contentframe');
          if (overlay && overlay.parentElement) {
            overlay.parentElement.removeChild(overlay);
          }
        });
        
        log.debug('Forcefully removed overlay via JavaScript');
        return true;
      } catch (e) {
        log.debug('Could not remove overlay via JavaScript');
      }
      
      log.debug('Could not dismiss email overlay after all attempts');
      return anyOverlayHandled;
    }
    
    return anyOverlayHandled;
  } catch (error) {
    log.error('Error handling overlays:', error);
    return anyOverlayHandled;
  }
}

// Helper function to detect and handle country selector page
async function handleCountrySelector(page: Page, originalUrl?: string): Promise<void> {
  try {
    // Check if we're on the country selector page by looking for multiple region accordions
    // The page has accordion buttons for different regions like "North & South America", "Europe", etc.
    const regionAccordions = await page.locator('button[data-testid^="accordion-button-disclosure-"]').count();
    
    // Also check for the presence of the North & South America button specifically
    const northAmericaButton = page.locator('button[data-testid^="accordion-button-disclosure-"]:has-text("North & South America")');
    const hasNorthAmericaButton = await northAmericaButton.isVisible({ timeout: 3000 }).catch(() => false);
    
    // If we have multiple region accordions and the North America button, we're on the country selector
    if (regionAccordions >= 3 && hasNorthAmericaButton) {
      log.debug('Country/region selector detected, selecting United States...');

      // Check if North & South America accordion is already expanded
      let isExpanded = await northAmericaButton.getAttribute('aria-expanded') === 'true';
      
      // Try clicking the accordion up to 2 times if needed
      for (let attempt = 0; attempt < 2 && !isExpanded; attempt++) {
        log.debug(`Expanding North & South America accordion (attempt ${attempt + 1})...`);
        await northAmericaButton.click();
        
        // Wait for the accordion animation to complete
        await page.waitForTimeout(1500);
        
        // Check if it's now expanded
        isExpanded = await northAmericaButton.getAttribute('aria-expanded') === 'true';
        
        if (!isExpanded && attempt === 0) {
          log.debug('First click didn\'t expand accordion, trying again...');
        }
      }
      
      if (!isExpanded) {
        log.debug('Failed to expand North & South America accordion after 2 attempts');
        return;
      }

      // Now look for the United States link within the expanded content
      // Based on the actual HTML: <li data-verifying-url="false"><a class="flex w-full justify-between font_small_xs_regular" href="/en-us"><span>United States</span><span>$</span></a></li>
      const usLinkSelectors = [
        'li[data-verifying-url="false"] a[href="/en-us"]',
        'a.font_small_xs_regular[href="/en-us"]',
        'a[href="/en-us"]:has(span:has-text("United States"))',
        'li a[href="/en-us"]',
        'a[href="/en-us"]'
      ];
      
      let usLink = null;
      for (const selector of usLinkSelectors) {
        try {
          const link = page.locator(selector);
          // Filter to only get the one with United States text
          const matchingLinks = await link.evaluateAll(links => 
            links.filter(el => el.textContent?.includes('United States'))
              .map(el => ({ href: el.getAttribute('href'), text: el.textContent }))
          );
          
          if (matchingLinks.length > 0) {
            usLink = link.first();
            log.debug(`Found United States link using selector: ${selector}`);
            break;
          }
        } catch (e) {
          // Try next selector
        }
      }

      if (usLink && await usLink.isVisible({ timeout: 2000 })) {
        log.debug('Clicking United States link...');
        await usLink.click();
        
        // Wait for navigation to complete
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
        
        // Additional wait to ensure page is fully loaded
        await page.waitForTimeout(2000);
        
        log.debug('Successfully navigated to US site');
        
        // Check if we were redirected away from the original page
        const currentUrl = page.url();
        
        // Handle index.html redirect with originPath
        if (currentUrl.includes('/index.html') && currentUrl.includes('originPath=') && originalUrl) {
          log.debug('Detected redirect to index.html with originPath, navigating back to original page...');
          await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(2000);
        } 
        // Handle redirect to base URL (e.g., /en-us) when we had a specific page
        else if (originalUrl && originalUrl.includes('/all-accessories.html') && !currentUrl.includes('/all-accessories.html')) {
          log.debug(`Redirected to base URL (${currentUrl}), navigating back to original page...`);
          await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(2000);
        }
      } else {
        log.debug('United States link not found after expanding North & South America section');
      }
    }
  } catch (error) {
    // If country selector detection fails, continue - this might not be the country selector page
    log.debug('No country selector detected or continuing with current page');
  }
}


export async function getItemUrls(page: Page): Promise<Set<string>> {
  const itemUrls = new Set<string>();
  // Updated selector based on actual HTML structure
  let workingSelector = 'a[href*="/product/"]';
  const originalUrl = page.url();
  
  // Check for overlays at the start
  await handleOverlays(page);

  // Main loop to handle products and country selector
  let productsFound = false;
  let attempts = 0;
  const maxAttempts = 3;
  
  while (!productsFound && attempts < maxAttempts) {
    attempts++;
    
    // Try to find product links
    try {
      await page.waitForSelector(workingSelector, { timeout: 5000 });
      log.debug(`Found products using primary selector (attempt ${attempts})`);
      productsFound = true;
      break;
    } catch (error) {
      log.debug(`Primary selector not found (attempt ${attempts})`);
    }
    
    // If no products found, check for country selector
    log.debug('No products found, checking for country selector...');
    
    // Wait a bit to ensure any delayed popups have appeared
    await page.waitForTimeout(2000);
    
    // Handle country selector, passing the original URL
    await handleCountrySelector(page, originalUrl);
    
    // The handleCountrySelector function will navigate back to original URL if needed
    // Loop will continue and try to find products again
  }

  if (!productsFound) {
    throw new Error('No product links found with any selector');
  }

  // Handle "Load More" functionality
  let loadMoreAttempts = 0;
  const maxLoadMoreAttempts = 50; // Safety limit to prevent infinite loops

  while (loadMoreAttempts < maxLoadMoreAttempts) {
    try {
      log.debug(`Load More attempt ${loadMoreAttempts + 1}...`);

      // Try multiple selectors for the Load More button
      const loadMoreSelectors = [
        'button:has-text("Load more products")',
        'button[class*="loading-button"]',
        'button:has([id="productsLoaded"])',
        'button:has-text("Load more")',
        'button[aria-valuemax]'
      ];

      let loadMoreButton = null;
      let workingSelector = '';

      for (const selector of loadMoreSelectors) {
        try {
          const button = page.locator(selector);
          if (await button.isVisible({ timeout: 2000 })) {
            loadMoreButton = button;
            workingSelector = selector;
            log.debug(`Found Load More button with selector: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (loadMoreButton) {
        // Check for overlays before interacting with Load More button
        await handleOverlays(page);
        
        // Extract current and total counts from the button
        const buttonText = await loadMoreButton.textContent();
        log.debug(`Load More button text: "${buttonText}"`);

        const countsMatch = buttonText?.match(/\((\d+)\/(\d+)\)/);

        if (countsMatch) {
          const currentCount = parseInt(countsMatch[1]);
          const totalCount = parseInt(countsMatch[2]);

          log.debug(`Load More: ${currentCount}/${totalCount} products loaded`);

          // If we've loaded all products, break
          if (currentCount >= totalCount) {
            log.debug(`All products loaded (${currentCount}/${totalCount})`);
            break;
          }
        } else {
          log.debug('Could not parse counts from Load More button, but will try clicking anyway');
        }

        // Scroll the button into view and click it
        let clickSuccess = false;
        let clickAttempts = 0;
        const maxClickAttempts = 3;
        let currentCount = 0;
        let totalCount = 0;
        
        // Extract counts for error reporting
        if (countsMatch) {
          currentCount = parseInt(countsMatch[1]);
          totalCount = parseInt(countsMatch[2]);
        }
        
        while (!clickSuccess && clickAttempts < maxClickAttempts) {
          try {
            log.debug(`Scrolling Load More button into view (click attempt ${clickAttempts + 1})...`);
            
            // Always handle overlays before each click attempt
            await handleOverlays(page);
            
            // Scroll the button into view
            await loadMoreButton.scrollIntoViewIfNeeded();
            await page.waitForTimeout(500);

            log.debug('Attempting to click Load More button...');
            
            if (clickAttempts < 2) {
              // First two attempts: try regular click
              await loadMoreButton.click({ timeout: 5000 });
            } else {
              // Final attempt: use JavaScript click to bypass any overlays
              log.debug('Using JavaScript click as fallback...');
              await page.evaluate((sel) => {
                const button = document.querySelector(sel);
                if (button && button instanceof HTMLElement) {
                  button.click();
                }
              }, workingSelector);
            }
            
            log.debug(`Successfully clicked Load More button (attempt ${loadMoreAttempts + 1})`);
            clickSuccess = true;

            // Wait for new products to load
            await page.waitForTimeout(3000);
          } catch (clickError: any) {
            clickAttempts++;
            log.debug(`Click attempt ${clickAttempts} failed: ${clickError.message}`);
            
            // After each failed attempt, check for overlays
            const overlayDismissed = await handleOverlays(page);
            if (overlayDismissed) {
              log.debug('Retrying Load More click after dismissing overlay...');
              await page.waitForTimeout(1000);
              continue; // Retry the click
            }
            
            if (clickAttempts >= maxClickAttempts) {
              log.error('Failed to click Load More button after multiple attempts');
              log.error('DEBUGGING: Pausing for 10 seconds to allow HTML extraction...');
              await page.waitForTimeout(10000); // Give you time to extract HTML
              
              throw new Error(`Failed to load all products: Could not click Load More button at ${currentCount}/${totalCount} products`);
            }
            
            await page.waitForTimeout(1000);
          }
        }

          // Wait for the loading to complete by checking if the count increases
          if (countsMatch) {
            const currentCount = parseInt(countsMatch[1]);
            let retries = 0;
            while (retries < 10) {
              try {
                // First check if the button still exists
                const buttonStillExists = await loadMoreButton.isVisible({ timeout: 100 }).catch(() => false);
                
                if (!buttonStillExists) {
                  log.debug('Load More button disappeared - all products loaded');
                  // Set a flag to break out of the outer loop
                  loadMoreAttempts = maxLoadMoreAttempts;
                  break;
                }
                
                const updatedButtonText = await loadMoreButton.textContent().catch(() => '');
                const updatedCountsMatch = updatedButtonText?.match(/\((\d+)\/(\d+)\)/);

                if (updatedCountsMatch) {
                  const updatedCurrentCount = parseInt(updatedCountsMatch[1]);
                  if (updatedCurrentCount > currentCount) {
                    log.debug(`Products updated to ${updatedCurrentCount}/${parseInt(updatedCountsMatch[2])}`);
                    break;
                  }
                }

                await page.waitForTimeout(1000);
                retries++;
              } catch (e) {
                break;
              }
            }

            if (retries >= 10) {
              log.debug('Timeout waiting for product count to update, continuing...');
            }
          }
        loadMoreAttempts++;
      } else {
        log.debug('No Load More button found, assuming all products are loaded');
        break;
      }
    } catch (error) {
      log.error(`Error during Load More attempt ${loadMoreAttempts + 1}:`, error);
      throw error; // Propagate the error instead of just breaking
    }
  }

  if (loadMoreAttempts >= maxLoadMoreAttempts) {
    log.debug(`Reached maximum Load More attempts (${maxLoadMoreAttempts}), continuing with current products`);
  }

  // Now extract all product URLs
  const links = await page.locator(workingSelector).evaluateAll(elements =>
    elements.map(el => (el as HTMLAnchorElement).href)
  );
  for (const link of links) {
    if (link) {
      itemUrls.add(new URL(link, page.url()).href);
    }
  }

  // Final validation: Check if we have a mismatch between expected and actual products
  // Look for any remaining Load More button to see if we missed products
  try {
    const finalLoadMoreButton = page.locator('button:has-text("Load more products")');
    if (await finalLoadMoreButton.isVisible({ timeout: 2000 })) {
      const finalButtonText = await finalLoadMoreButton.textContent();
      const finalCountsMatch = finalButtonText?.match(/\((\d+)\/(\d+)\)/);
      
      if (finalCountsMatch) {
        const currentCount = parseInt(finalCountsMatch[1]);
        const totalCount = parseInt(finalCountsMatch[2]);
        
        if (currentCount < totalCount) {
          throw new Error(`Failed to load all products: Only loaded ${currentCount} out of ${totalCount} products. Found ${itemUrls.size} unique URLs.`);
        }
      }
    }
  } catch (error: any) {
    if (error.message?.includes('Failed to load all products')) {
      throw error;
    }
    // Ignore other errors in final check
  }

  log.debug(`Final result: Found ${itemUrls.size} unique product URLs after ${loadMoreAttempts} Load More attempts`);
  return itemUrls;
}

export async function paginate(page: Page): Promise<boolean> {
  const nextPageButtonSelector = 'button.Pagination-module--nextButton__HwgXp:not(.CTA-module--disabled__34PlQ)';
  const nextPageButton = page.locator(nextPageButtonSelector);

  // First try to find the pagination button
  let buttonVisible = false;
  try {
    buttonVisible = await nextPageButton.isVisible({ timeout: 3000 });
  } catch (e) {
    // Button not immediately visible
  }

  // If pagination button not found, check for country selector
  if (!buttonVisible) {
    const currentUrl = page.url();
    
    // Check if we need to handle country selector
    for (let attempt = 0; attempt < 2 && !buttonVisible; attempt++) {
      log.debug(`Pagination button not found, checking for country selector (attempt ${attempt + 1})...`);
      await page.waitForTimeout(2000);
      await handleCountrySelector(page, currentUrl);
      
      // Try to find pagination button again
      try {
        buttonVisible = await nextPageButton.isVisible({ timeout: 5000 });
      } catch (e) {
        buttonVisible = false;
      }
    }
  }

  if (buttonVisible) {
    try {
      await nextPageButton.click({ timeout: 5000 });
      await page.waitForTimeout(3000);
      return true;
    } catch (error) {
      log.error('Error clicking next page button or timeout:', error);
      return false;
    }
  }
  return false;
}

const parsePrice = (text: string | null | undefined): number | undefined => {
  if (!text) return undefined;
  const cleanedText = text.replace(/[^\d.]/g, '');
  const price = parseFloat(cleanedText);
  return isNaN(price) ? undefined : price;
};

export async function scrapeItem(page: Page, options?: { 
  scrapeImages?: boolean;
  existingImages?: Array<{ sourceUrl: string; mushUrl: string }>;
  uploadToS3?: boolean;
}): Promise<Item[]> {
  try {
    // log.debug('scrapeItem - Received page object for:', page.url());

    const sourceUrl = page.url();

    // Check if this is a valid product page by looking for key product elements
    let isProductPage = await page.evaluate(() => {
      // Check for product-specific elements that should exist on a product page
      const hasProductTitle = !!document.querySelector('h1[data-testid="product-name"]');
      const hasProductPrice = !!document.querySelector('[data-testid="product-price"]');
      const hasSizeSelector = !!document.querySelector('[data-testid="select-size-btn"]');
      const hasProductImages = !!document.querySelector('img[alt*="RELAXED"], img[alt*="SLIM"], img[alt*="REGULAR"], img[alt*="KNITTED"], img[alt*="ELASTICATED"], img[alt*="TAILORED"], img[alt*="LINEN"], img[alt*="COTTON"], img[alt*="SILK"]');

      // If none of the key product elements exist, this is not a product page
      return hasProductTitle || hasProductPrice || hasSizeSelector || hasProductImages;
    });

    // If not a product page, check for country selector
    if (!isProductPage) {
      // Try handling country selector up to 2 times
      for (let attempt = 0; attempt < 2 && !isProductPage; attempt++) {
        log.debug(`Product elements not found, checking for country selector (attempt ${attempt + 1})...`);
        await page.waitForTimeout(2000);
        await handleCountrySelector(page, sourceUrl);
        
        // Re-check if it's now a valid product page
        isProductPage = await page.evaluate(() => {
          const hasProductTitle = !!document.querySelector('h1[data-testid="product-name"]');
          const hasProductPrice = !!document.querySelector('[data-testid="product-price"]');
          const hasSizeSelector = !!document.querySelector('[data-testid="select-size-btn"]');
          const hasProductImages = !!document.querySelector('img[alt*="RELAXED"], img[alt*="SLIM"], img[alt*="REGULAR"], img[alt*="KNITTED"], img[alt*="ELASTICATED"], img[alt*="TAILORED"], img[alt*="LINEN"], img[alt*="COTTON"], img[alt*="SILK"]');
          return hasProductTitle || hasProductPrice || hasSizeSelector || hasProductImages;
        });
      }
    }

    if (!isProductPage) {
      // Throw a network error to trigger retry, as COS might be redirecting to stop scrapers
      log.error(`COS: Not a valid product page (redirected/blocked): ${sourceUrl}`);
      const error = new Error(`Network error: redirected improperly from ${sourceUrl}`);
      (error as any).code = 'ENETWORK';
      throw error;
    }

    const title = await page.$eval('h1[data-testid="product-name"]', el => el.textContent?.trim() || '').catch(() => '');

    const currentPriceText = await page.$eval('[data-testid="product-price"]', el => el.textContent?.trim() || null).catch(() => null);
    // COS does not seem to consistently show original price on product page in a standard way.
    // const originalPriceText = null; // Keep as null or implement specific logic if found

    let description = await page.$$eval('.accordion-inner-content.product-description .description-text p, .accordion-inner-content.product-description .description-text li',
      elements => elements.map(p => p.textContent?.trim()).filter(Boolean).join('\n')
    ).catch(() => '');

    if (!description) {
      description = await page.$eval('meta[name="description"]', el => el.getAttribute('content')?.trim() || '').catch(() => '');
    }

    // Updated selector to match current HTML structure - only get main product images
    const imageSelector = '.lg\\:col-span-8 button[data-index] img';

    const imagesRaw = await page.$$eval(imageSelector, (imgElements, pTitle) => {
      // This entire function runs in the browser context.
      // Keep it as plain JavaScript as possible.
      // Avoid TypeScript specific syntax (types, assertions) here.
      // Avoid complex nested functions if possible.

      const collectedImages = [];
      const seenImageUrls = new Set();

      for (let i = 0; i < imgElements.length; i++) {
        const imgElement = imgElements[i];
        // Get the highest quality image URL from srcset or src
        let url = imgElement.getAttribute('src');
        const srcset = imgElement.getAttribute('srcset');
        if (srcset) {
          // Extract the highest resolution URL from srcset
          const srcsetUrls = srcset.split(',').map(s => s.trim());
          const highestRes = srcsetUrls[srcsetUrls.length - 1]; // Last one is usually highest res
          if (highestRes) {
            url = highestRes.split(' ')[0]; // Extract URL part
          }
        }
        if (url) {
          url = url.trim();
          if (url.startsWith('//')) {
            url = 'https:' + url;
          }
        }

        if (url && url.startsWith('http') && !url.includes('blank=') && url !== 'https://' && url !== 'http://') {
          const imageDetails = {
            sourceUrl: url,
            alt: imgElement.getAttribute('alt')?.trim() || pTitle,
          };
          if (!seenImageUrls.has(imageDetails.sourceUrl)) {
            collectedImages.push(imageDetails);
            seenImageUrls.add(imageDetails.sourceUrl);
          }
        }
      }
      return collectedImages;
    }, title).catch((err) => {
      // This console.error runs in Node.js context if page.$$eval itself throws an error
      log.error('Error during page.$$eval for images:', err.message);
      return [];
    });


    const productId = await page.evaluate(() => {
      // Extract from URL pattern: /product/name-color-PRODUCTID
      const urlMatch = window.location.pathname.match(/-(\d+)$/);;
      if (urlMatch) {
        return urlMatch[1];
      }
      // Fallback to extracting from URL
      return window.location.pathname.split('/').pop()?.split('-').pop() || '';
    }).catch(() => '');

    const currencySymbol = await page.$eval('[data-testid="product-price"]', el => el.textContent?.trim().replace(/[\d.,\s]/g, '') || '$')
      .catch(() => '$');

    const sizeDetails = await page.$$eval('button[data-testid^="size-selector-button-"]', buttons =>
      buttons.map(btn => {
        const sizeText = btn.querySelector('span')?.textContent?.trim() || '';
        // Check if unavailable by looking for diagonal line or notify-me icon
        const hasNotifyIcon = !!btn.querySelector('[data-testid="notify-me-icon"]');
        const hasDiagonalLine = !!btn.querySelector('.after\\:bg-main-diagonal-line');
        return {
          size: sizeText,
          is_available: !hasNotifyIcon && !hasDiagonalLine,
        };
      }).filter(s => s.size)
    ).catch(() => []);

    const color = await page.$eval('[data-testid="variant-color-heading"] + span', el => el.textContent?.trim() || '').catch(() => '');

    let price: number | undefined;
    let sale_price: number | undefined;
    // COS doesn't reliably show originalPriceText in a standard selector
    // if (originalPriceText) {
    //   price = parsePrice(originalPriceText);
    //   sale_price = parsePrice(currentPriceText);
    // } else {
    price = parsePrice(currentPriceText);
    sale_price = undefined; // Assuming no sale if originalPriceText isn't found/used
    // }

    let currency = 'USD';
    if (currencySymbol === '$') currency = 'USD';
    // Add more currency mappings if needed

    const mappedSizes: Size[] = Array.isArray(sizeDetails) ? sizeDetails.map(s => ({
      size: s.size,
      is_available: s.is_available,
    })) : [];

    // Image handling with existing images support
    let processedImages: Image[] = [];
    
    if (options?.existingImages && !options?.scrapeImages) {
      // Use existing images from database - no scraping or S3 upload
      log.debug(`Using ${options.existingImages.length} existing images from database`);
      processedImages = options.existingImages.map(img => ({
        sourceUrl: img.sourceUrl,
        mushUrl: img.mushUrl,
        alt_text: undefined
      }));
    } else {
      // Normal image scraping flow
      if (imagesRaw && Array.isArray(imagesRaw) && imagesRaw.length > 0) {
        // Ensure that imagesRaw objects are treated as type Image for the upload function if they are compatible.
        // The uploadImagesToS3AndAddUrls function is expected to add mushUrl and return the updated array.
        if (options?.uploadToS3 !== false) {
        processedImages = await uploadImagesToS3AndAddUrls(imagesRaw as Omit<Image, 'mushUrl'>[], DOMAIN);
      } else {
        // Skip S3 upload, just use scraped images with sourceUrl only
        processedImages = (imagesRaw as any[]).map(img => ({
          sourceUrl: img.sourceUrl,
          alt_text: img.alt_text || img.alt
        }));
      }
      } else {
        log.debug('No images found in imagesRaw to process for S3 upload.');
      }
    }

    // Additional validation: if we don't have a title or product ID, this might not be a valid product
    if (!title && !productId) {
      // Throw a network error to trigger retry, as COS might be redirecting to stop scrapers
      log.error(`COS: Missing essential product data (no title/ID): ${sourceUrl}`);
      const error = new Error(`Network error: redirected improperly from ${sourceUrl} - Missing essential product data`);
      (error as any).code = 'ENETWORK';
      throw error;
    }

    const item: Partial<Item> = {
      sourceUrl: sourceUrl,
      product_id: productId || 'unknown',
      title: title || 'Unknown Product',
      description: description,
      price: price ?? 0,
      sale_price,
      currency,
      images: processedImages.length > 0 ? processedImages : undefined,
      sizes: mappedSizes.length > 0 ? mappedSizes : undefined,
      color: color || undefined,
    };

    return [formatItem(item as Item)];

  } catch (error) {
    log.error(`Error in scrapeItem for ${page.url()}:`, error);
    throw error;
  }
}

const scraper = {
  paginate,
  getItemUrls,
  scrapeItem,
};

export default scraper; 