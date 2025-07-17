
# Rules for Creating New Scrapers

## Getting Started
Look at the existing scrapers in [src/scrapers/](mdc:src/scrapers) to get an idea of how to structure your new scraper. The scraper for `iam-store.com.ts` ([src/scrapers/iam-store.com.ts](mdc:src/scrapers/iam-store.com.ts)) is a good reference for the current standard structure.

1.  **Initial Site Configuration via API:**
    *   The **first step** is to register the new site and its initial scraping configuration (scraper file name and start page URLs) with the remote API.
    *   Use the `npm run site:config:set` script for this.
    *   **Ask the user for the `startPage(s)` (URLs only) if they haven't been provided.**
    *   **Usage:**
        ```bash
        npm run site:config:set -- <domain> <scraper-file.ts> <startPage1[,startPage2,...]>
        ```
    *   **Example:**
        ```bash
        npm run site:config:set -- yourdomain.com yourdomain.com.ts https://yourdomain.com/products,https://yourdomain.com/sale
        ```
    *   This script calls the `PATCH /api/sites/{siteId}/scraping-config` endpoint using the `updateSiteScrapingConfig` function from `src/providers/etl-api.ts`.
    *   **Check/Create Site Record:** The script should handle ensuring a site record for the `<domain>` exists. If there are issues, you might need to manually check or create it (e.g., via a `POST /api/sites` if available, providing at least the domain name).
    *   To include browser configuration (headless, userAgent, headers, etc.), you will need to modify the `src/scripts/set-site-config.ts` script or the payload sent by the `updateSiteScrapingConfig` function it calls.
    *   To remove scraping configuration, send `{"scrapeConfig": null}`. This might require a separate script or modification to the existing one to handle a null payload.
    *   **Verify:** After running the command, use `npm run site:config:get -- <domain>` to fetch the configuration from the API and confirm it was set correctly.
2.  Ask the user to provide the domain (if not already known for the config step).
3.  Ask the user to provide the HTML for the product listing page(s).
4.  Ask the user to provide the HTML for a single product page (provide examples for both regular and sale priced items if possible).
5.  **Create the scraper file** (e.g., `src/scrapers/yourdomain.com.ts`) implementing the required functions (see below). Ensure the filename matches what was used in the `set-scrape-config` command.
6.  **Register and Configure the Site via API:**
    *   **Check/Create Site Record:** Ensure a record for the `<domain>` exists in the remote database. If it doesn't, you may need to create it first using the appropriate API endpoint (e.g., potentially `POST /api/sites` if available, providing at least the domain name).
    *   **Set Scraping Configuration:** Use the `npm run site:config:set` script to set or update the scraping details (scraper file and start pages) via the API. 
        *   **Usage:**
            ```bash
            npm run site:config:set -- <domain> <scraper-file.ts> <startPage1[,startPage2,...]>
            ```
        *   **Example:**
            ```bash
            npm run site:config:set -- yourdomain.com yourdomain.com.ts https://yourdomain.com/products,https://yourdomain.com/sale
            ```
        *   This script calls the `PATCH /api/sites/{siteId}/scraping-config` endpoint using the `updateSiteScrapingConfig` function from `src/providers/etl-api.ts`.
        *   To include browser configuration (headless, userAgent, headers, etc.), you will need to modify the `src/scripts/set-site-config.ts` script or the payload sent by the `updateSiteScrapingConfig` function it calls.
        *   To remove scraping configuration, send `{"scrapeConfig": null}`. This might require a separate script or modification to the existing one to handle a null payload.
    *   **Verify:** Use `npm run site:config:get -- <domain>` to fetch the configuration from the API and confirm it was set correctly.

## Scraper Structure and Function Responsibilities

Scrapers **MUST** adhere to the functional pattern seen in `iam-store.com.ts`, exporting the following **REQUIRED** async functions both as **named exports** and as part of the **default export object**:

*   **`export async function getItemUrls(page: Page): Promise<Set<string>>`** (REQUIRED):
    *   **Responsibility:** Extract *only* product URLs from the *current* listing page DOM.
    *   Do **not** extract prices, titles, images, or other details here.
    *   Resolve URLs to absolute paths within this function (e.g., using `new URL(relativeUrl, page.url()).href` or `new URL(relativeUrl, document.baseURI).href` inside `page.evaluate`).
    *   Wait for relevant selectors to ensure the product grid/links are loaded before extraction.
*   **`export async function paginate(page: Page): Promise<boolean>`** (REQUIRED):
    *   **Responsibility:** Advance to the *next* page of results if pagination exists.
    *   **CRITICAL:** This function handles ALL navigation internally. The calling code will NOT track URLs or manage navigation between pages.
    *   **How it works:** The function receives a Page object that is already on a listing page. It should:
        - For numbered pagination: Click the next page button/link to navigate to the next page
        - For infinite scroll: Scroll to trigger loading more items on the same page
        - For load-more buttons: Click the button to load additional items
    *   **The Page object persists:** The same Page instance is reused across multiple calls. After `paginate()` returns `true`, the page will be in the new state (either navigated to a new URL or with more items loaded).
    *   Return `true` if more items are available (either by navigating to a new page or loading more items), `false` when no more items can be loaded.
    *   **IMPORTANT:** For sites with no pagination (all items on one page), this function **MUST** still be exported and should simply `return false;`.
*   **`export async function scrapeItem(page: Page): Promise<Item>`** (REQUIRED):
    *   **Responsibility:** Scrape all details for a *single* product from its dedicated page. The `page` object is already navigated to the correct product URL.
    *   Use `page.url()` to get the `sourceUrl` for the item.
    *   Do **NOT** launch a browser (`playwright.chromium.launch()`), create a context (`browser.newContext()`), create a page (`browser.newPage()`), or navigate (`page.goto(url)`) within this function. These are handled by the caller.
    *   **IMPORTANT:** Use `page.evaluate` primarily to extract *raw text and attributes* from the DOM. Perform data parsing, cleaning, and transformation (e.g., using a local `parsePrice` function) *outside* of `page.evaluate`, back in the Node.js context.
    *   Extract title, price (and sale price), description, images, sizes (if available), currency, and product ID (or SKU).
    *   Handle price extraction carefully (see "Price Handling" section below).
    *   Extract image URLs and alt text. Use the `uploadImagesToS3AndAddUrls` helper from [`src/utils/image-utils.ts`](mdc:src/utils/image-utils.ts) to upload images and get `mushUrl`.
    *   Construct and return an `Item` object (defined in [`src/types/item.ts`](mdc:src/types/item.ts)). Use `formatItem` from [`src/db/db-utils.ts`](mdc:src/db/db-utils.ts) before returning.
    *   **VERY IMPORTANT:** Do NOT add new fields to the `Item` type (defined in `src/types/item.ts`) or attempt to scrape data for fields not already present in the `Item` type without explicit confirmation from the user. If you believe a new field is necessary, discuss it first.
    *   The browser lifecycle (closing browser/context/page) is managed by the caller.

The module **MUST** then export a default object conforming to the `Scraper` type, containing **ALL** three functions (`paginate`, `getItemUrls`, `scrapeItem`):
```typescript
import type { Scraper } from './types.js'; // Path relative to src/scrapers/

// Import or define the required functions (getItemUrls, paginate, scrapeItem)
// Ensure they are also exported individually using the 'export' keyword as shown above.

const scraper: Scraper = {
  paginate,
  getItemUrls,
  scrapeItem
};

export default scraper;
```

## Libraries and Utilities

*   **Core Library:** Use `playwright` for browser automation, not `puppeteer`.
*   **Utility Functions:**
    *   Avoid importing general utility functions like `ensureValidUrl` from `src/utils/`. Instead, handle tasks like URL resolution directly within the relevant function (e.g., `getItemUrls`).
    *   For price parsing (`parsePrice`), if complex logic is needed, define a local helper function *within* the scraper file (e.g., `src/scrapers/leskizzo.com.ts` has an example). Do not import shared price parsing utilities unless strictly necessary and confirmed to be standard practice.
    *   Use `uploadImagesToS3AndAddUrls` from [`src/utils/image-utils.ts`](mdc:src/utils/image-utils.ts) for handling image uploads.
    *   Use `getSiteConfig` from [`src/drivers/site-config.ts`](mdc:src/drivers/site-config.ts). This function fetches configuration from the remote API.
    *   Use `formatItem` from [`src/db/db-utils.ts`](mdc:src/db/db-utils.ts).

## Price Handling (`price` vs `sale_price`)

When extracting product prices within `scrapeItem`, adhere to the following standard:

1.  **`price` (Required, `number`):** This field should **always** store the *original* or *base* price of the item, before any discounts.
2.  **`sale_price` (Optional, `number`):** This field should store the *discounted* or *sale* price **only if** the item is currently on sale.

**Common Patterns & Implementation:**

*   **Sale Indicated by `<del>`/`<ins>`:** Many sites show sales like `<del>$100</del> <ins>$80</ins>`.
    *   Extract the value from `<del>` (or equivalent selector for original price) for the `price` field.
    *   Extract the value from `<ins>` (or equivalent selector for sale price) for the `sale_price` field.
*   **Single Price Displayed:** If only one price is shown, assume it's the current price.
    *   If you can determine it's a sale price (e.g., based on a sale badge or class on the price element), try to find the original price elsewhere (maybe in JSON data, meta tags, or attributes). If found, store it in `price` and the displayed price in `sale_price`.
    *   If you cannot determine if it's a sale or cannot find the original price, store the displayed price in the `price` field and leave `sale_price` as `undefined`.
*   **Data Attributes/JSON:** Sometimes prices are stored in `data-*` attributes or embedded JSON within `<script>` tags. Prioritize extracting from these structured sources if available, as they are often more reliable than parsing text content.
*   **Parsing:** Use a local `parsePrice` helper (defined *outside* `page.evaluate`) if needed, or perform inline cleaning (`.replace(/[^\d.]/g, '')`) and `parseFloat` *after* extracting raw text from the browser context. Handle different currency symbols and decimal separators carefully. Extract the `currency` code (e.g., 'UAH', 'USD', 'EUR').

**Example Logic (Conceptual within `scrapeItem`):**

```typescript
// Local helper function (defined in Node.js scope, outside evaluate)
const parsePrice = (text: string | null | undefined): number | undefined => { /* ... parsing logic ... */ };

// --- Inside scrapeItem, after navigating to the product page ---

// Extract RAW data from the browser context
const rawDetails = await page.evaluate(() => {
  const title = document.querySelector(/* ... */)?.textContent?.trim() || '';
  // ... other raw data extractions ...
  const originalPriceElement = document.querySelector('selector-for-original-price');
  const salePriceElement = document.querySelector('selector-for-sale-price');
  const currentPriceElement = document.querySelector('selector-for-current-price');
  const currencySymbol = document.querySelector('selector-for-currency')?.textContent || 'USD';

  // Extract RAW text for prices
  const originalPriceText = originalPriceElement?.textContent || null;
  const salePriceText = salePriceElement?.textContent || null;
  const currentPriceText = currentPriceElement?.textContent || null;

  return {
    title,
    // ... other raw data ...
    originalPriceText,
    salePriceText,
    currentPriceText,
    currencySymbol
  };
});

// --- Back in Node.js context: Parse and process RAW data ---
let price: number | undefined;
let sale_price: number | undefined;
let currency = 'USD'; // Default

// Use local parsePrice helper on the RAW text extracted earlier
if (rawDetails.originalPriceText && rawDetails.salePriceText) {
  price = parsePrice(rawDetails.originalPriceText);
  sale_price = parsePrice(rawDetails.salePriceText);
} else if (rawDetails.currentPriceText) {
  price = parsePrice(rawDetails.currentPriceText);
  sale_price = undefined; // Assume not on sale or original unknown
}
// ... Add more robust logic as needed ...

// Map currency symbol to code
if (rawDetails.currencySymbol === '₴') currency = 'UAH';
else if (rawDetails.currencySymbol === '€') currency = 'EUR';
// ... other currencies ...

// Construct Item...
const item: Item = {
  // ...,
  title: rawDetails.title, // Use raw title
  price: price ?? 0, // Use PARSED price, ensure fallback
  sale_price,        // Use PARSED sale price
  currency,          // Use mapped currency code
  // ...
};

return formatItem(item);

```

Always verify the site's specific HTML structure to choose the correct selectors and adapt the parsing logic.

## Best Practices
*   **Timeouts:** When waiting for selectors (e.g., using `page.waitForSelector()`), especially for critical elements like product titles or grids, use a sufficiently long timeout, generally 10000ms (10 seconds), to accommodate varying page load times and dynamic content. Ensure that any modal dialogs or overlays are handled *before* these waits, and that modal handlers also have adequate timeouts.
*   **Troubleshooting Playwright Evaluation Context Errors (e.g., `page.evaluate`, `page.$eval`, `page.$$eval`):**
    *   **Common Error: `ReferenceError: __name is not defined` (or similar)**
        *   **Primary Cause:** This error (and others like it) usually means there's an issue with how Playwright serializes your JavaScript/TypeScript callback function and how it's subsequently executed in the browser's isolated JavaScript context. Modern JavaScript syntax (especially arrow functions with specific transpilation outputs, complex default parameters, or class structures) or any TypeScript-specific syntax within these callbacks can trigger these errors because the browser context lacks the necessary transpiled helper functions (like `__name`) or type information.
        *   **Key Solutions & Debugging Steps:**
            1.  **Keep Browser-Context Callbacks Simple & Plain:** The functions you pass to be executed in the browser (e.g., `(elements, arg) => { /* browser code */ }`) should be as close to plain, traditional JavaScript as possible. Avoid complex closures or relying on a rich lexical environment from your Node.js scope.
            2.  **Eliminate TypeScript Syntax *Inside* Callbacks:** Absolutely no TypeScript type annotations (e.g., `el: string`), type assertions (e.g., `el as HTMLImageElement`), or other TypeScript-specific constructs *within the body of the callback function that runs in the browser*. These are for your Node.js/TypeScript static analysis environment and are stripped/transpiled in ways that can break browser execution.
            3.  **Prefer Simpler Loop Constructs:** If using `Array.prototype.forEach` with an arrow function callback *inside* a `page.$$eval` (or similar) leads to errors, try a standard `for...of` loop or a `for (let i = 0; ...)` loop instead. These are generally safer for browser-context execution.
                *   *Problematic Example (Potentially):*
                    ```typescript
                    await page.$$eval('selector', (elements) => {
                      elements.forEach(el => { /* complex logic using el */ });
                    });
                    ```
                *   *Safer Alternative (used in `cos.com.ts`):*
                    ```typescript
                    await page.$$eval('selector', (elements) => {
                      for (const el of elements) { /* complex logic using el */ }
                    });
                    ```
            4.  **Avoid Nested Named Function Declarations *Inside* Callbacks:** While sometimes okay, defining a named function `function helper() {...}` *inside* the callback you pass to `page.$$eval` can sometimes contribute to serialization issues. If possible, inline the logic or ensure such helper functions are also extremely simple plain JavaScript. The final working version for `cos.com.ts` inlined all image processing logic rather than using an inner `getSingleImageUrl` helper.
            5.  **Granular Data Extraction:** Instead of one massive `page.evaluate` block that tries to do everything, prefer smaller, more targeted calls. This makes debugging easier and often sidesteps complex serialization issues.
                *   For single elements: `const text = await page.$eval('selector', el => el.textContent);`
                *   For multiple elements: `const allTexts = await page.$$eval('selectorAll', els => els.map(el => el.textContent));`
                *   Refer to `src/scrapers/cos.com.ts` for an example of this granular approach.
            6.  **Pass Data from Node.js to Browser Context Explicitly:** Variables from your Node.js scope are *not* automatically available inside the browser-scope callback. If your browser-side logic needs a value from your Node.js script (e.g., a product title for fallback alt text), pass it as an additional argument to `page.$eval` or `page.$$eval`.
                *   *Example (from `src/scrapers/cos.com.ts` image extraction):*
                    ```typescript
                    // In Node.js scope:
                    const titleFromNode = await page.$eval(/* ... */); // Example: actual title extraction
                    const imageSelector = 'ul#mainImageList img[data-zoom-src]';

                    const imagesData = await page.$$eval(
                      imageSelector, // Selector
                      (browserImgElements, pTitle) => { // Callback runs in browser
                        // pTitle (second arg in callback) now holds the value of titleFromNode (third arg to $$eval)
                        const collected = [];
                        for (const imgEl of browserImgElements) {
                          let url = imgEl.getAttribute('data-zoom-src');
                          // ... further URL processing (trim, add https, fallback to src)
                          const altText = imgEl.getAttribute('alt')?.trim() || pTitle;
                          if (url /* && is valid */) {
                             collected.push({ url: url, alt: altText });
                          }
                        }
                        return collected;
                      },
                      titleFromNode // Argument passed from Node.js, becomes pTitle in browser
                    );
                    ```
            7.  **Check Playwright's Own Debugging:** Use Playwright's debugging tools (`PWDEBUG=1` environment variable or `await page.pause()`) to inspect the page state and test selectors directly in the browser opened by Playwright.
            8.  **Isolate the Failing Callback:** If you have a complex callback, comment out parts of it progressively to pinpoint which specific line or JavaScript feature is causing the serialization/execution error.
*   **Selector Specificity and Robustness:**
    *   **Balancing Act:** Start with reasonably specific selectors to avoid ambiguity. If they are too brittle (break with minor site changes) or don't find elements, cautiously broaden them. Focus on stable attributes like `id`, `data-*` attributes, or class names that seem structural rather than purely stylistic.
    *   **Example - Evolving a Selector:** For `cos.com.ts` images, an initial overly specific selector might have failed. Simplifying to `ul#mainImageList img[data-zoom-src]` proved more robust by targeting any `img` with the crucial `data-zoom-src` attribute under a known parent.
    *   **Debugging with `page.content()`:** If selectors are not working as expected, temporarily log `await page.content()` in your Node.js script *before* the failing `page.$eval` or `page.$$eval` call. This gives you the exact HTML Playwright is seeing, which can differ from what your browser shows if JavaScript modifies the DOM heavily.
*   **Logging from Browser Context:**
    *   `console.log` statements *inside* `page.evaluate` (and its variants) will appear in your terminal output (prefixed by Playwright). This is invaluable for debugging the logic running in the browser.
    *   Remember that variables from the Node.js scope cannot be directly referenced in these browser-side `console.log`s unless passed as arguments (see point 1.f above).
        *   *Incorrect (browser-scope log trying to access Node.js var `mySelector`):*
            ```typescript
            // Node.js scope
            const mySelector = '#id';
            await page.evaluate(() => {
              console.log('Selector was: ' + mySelector); // ERROR: mySelector is not defined here
            });
            ```
        *   *Correct (passing as arg):*
            ```typescript
            // Node.js scope
            const mySelector = '#id';
            await page.evaluate((selectorToShow) => {
              console.log('Selector was: ' + selectorToShow);
            }, mySelector);
            ```


            ## Best Practices
*   **Timeouts:** When waiting for selectors (e.g., using `page.waitForSelector()`), especially for critical elements like product titles or grids, use a sufficiently long timeout, generally 10000ms (10 seconds), to accommodate varying page load times and dynamic content. Ensure that any modal dialogs or overlays are handled *before* these waits, and that modal handlers also have adequate timeouts.
*   **Troubleshooting `page.evaluate`, `page.$eval`, and `page.$$eval`:**
    *   **`ReferenceError: __name is not defined` (and similar errors):** This error often indicates issues with how JavaScript/TypeScript code is stringified and executed in the browser's context. It can be caused by:
        *   Complex JavaScript syntax (e.g., arrow functions with implicit returns, classes, modern ES features that don't transpile cleanly for the browser context).
        *   TypeScript-specific syntax like type annotations (`: string`) or type assertions (`as HTMLInputElement`) within the callback functions.
    *   **To Avoid These Errors:**
        1.  **Keep Callbacks Plain:** Functions passed to `page.evaluate`, `page.$eval`, and `page.$$eval` should be as close to plain, traditional JavaScript as possible.
        2.  **Prefer `function` Declarations:** If arrow functions cause issues, switch to traditional `function foo() {}` declarations for the callbacks.
        3.  **Remove TypeScript Syntax:** Ensure no TypeScript type annotations or assertions are present *inside* these browser-context callback functions. Perform type operations in the Node.js scope if needed.
        4.  **Granular Extractions:** Instead of one massive `page.evaluate` block, prefer smaller, more targeted calls:
            *   Use `page.$eval('selector', el => el.textContent)` for single elements.
            *   Use `page.$$eval('selectorAll', els => els.map(el => el.textContent))` for multiple elements.
            *   This often leads to more robust serialization and execution of the callback functions.
        5.  **Pass Data as Arguments:** If the browser-context function needs data from your Node.js scope (e.g., a product title to use as a fallback for image alt text), pass it as an argument to `page.$eval` or `page.$$eval`. For `page.$$eval(selector, (elements, arg1, arg2) => { ... }, arg1FromNode, arg2FromNode)`. For `page.$eval(selector, (element, arg1) => { ... }, arg1FromNode)`. 

        ## Best Practices
*   **Timeouts:** When waiting for selectors (e.g., using `page.waitForSelector()`), especially for critical elements like product titles or grids, use a sufficiently long timeout, generally 10000ms (10 seconds), to accommodate varying page load times and dynamic content. Ensure that any modal dialogs or overlays are handled *before* these waits, and that modal handlers also have adequate timeouts.
*   **Page Navigation (`page.goto`):**
    *   **Timeout:** Always use a timeout for `page.goto()`, typically 10000ms (10 seconds), to prevent indefinite hanging.
    *   **`waitUntil` Option:** Prefer `waitUntil: 'domcontentloaded'` for `page.goto()` calls. This waits for the initial HTML to load and parse, which is often sufficient and faster than the default 'load' event (which waits for all resources like images and stylesheets). Scraper-specific `waitForSelector` calls should then be used to ensure critical content is ready before extraction.
*   **Troubleshooting Playwright Evaluation Context Errors (e.g., `page.evaluate`, `page.$eval`, `page.$$eval`):


