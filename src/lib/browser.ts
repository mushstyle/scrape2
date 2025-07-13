import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { BrowserOptions, BrowserResult } from '../types/browser.js';

/**
 * Create a Playwright browser instance from either Browserbase or local Chrome
 */
export async function createBrowser(options: BrowserOptions): Promise<BrowserResult> {
  // Default to blocking images for bandwidth savings
  const blockImages = options.blockImages ?? true;
  
  let browser: Browser;
  
  if (options.provider === 'browserbase') {
    let wsUrl: string;
    
    if (options.connectUrl) {
      // Use the provided connect URL from Browserbase session response
      wsUrl = options.connectUrl;
    } else if (options.sessionId) {
      // Legacy: construct URL from sessionId (deprecated)
      const apiKey = process.env.BROWSERBASE_API_KEY;
      if (!apiKey) {
        throw new Error('BROWSERBASE_API_KEY environment variable is required');
      }
      wsUrl = `wss://ws.browserbase.com?apiKey=${apiKey}&sessionId=${options.sessionId}`;
    } else {
      throw new Error('Either connectUrl or sessionId is required for browserbase provider');
    }
    
    // Connect to Browserbase via CDP
    browser = await chromium.connectOverCDP(wsUrl);
  } else if (options.provider === 'local') {
    // Local browser is always headed
    browser = await chromium.launch({
      headless: false
    });
  } else {
    throw new Error(`Unknown browser provider: ${options.provider}`);
  }

  // Override newContext to add image blocking
  if (blockImages) {
    const originalNewContext = browser.newContext.bind(browser);
    browser.newContext = async (options?: any) => {
      const context = await originalNewContext(options);
      
      // Block image requests
      await context.route('**/*', (route) => {
        const request = route.request();
        const resourceType = request.resourceType();
        if (resourceType === 'image') {
          route.abort();
        } else {
          route.continue();
        }
      });
      
      return context;
    };
  }

  return {
    browser,
    cleanup: async () => {
      await browser.close();
    }
  };
}