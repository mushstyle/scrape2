import { chromium, Browser, BrowserContext } from 'playwright';
import type { BrowserOptions, BrowserResult } from '../types/browser.js';

/**
 * Create a Playwright browser instance from either Browserbase or local Chrome
 */
export async function createBrowser(options: BrowserOptions): Promise<BrowserResult> {
  // Default to blocking images for bandwidth savings
  const blockImages = options.blockImages ?? true;
  
  let browser: Browser;
  
  if (options.provider === 'browserbase') {
    if (!options.sessionId) {
      throw new Error('sessionId is required for browserbase provider');
    }
    
    const apiKey = process.env.BROWSERBASE_API_KEY;
    if (!apiKey) {
      throw new Error('BROWSERBASE_API_KEY environment variable is required');
    }

    // Construct WebSocket URL for Browserbase
    const wsUrl = `wss://ws.browserbase.com?apiKey=${apiKey}&sessionId=${options.sessionId}`;
    
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