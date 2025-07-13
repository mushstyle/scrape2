import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import type { Session } from '../types/session.js';
import { formatProxyForPlaywright } from './proxy.js';

export interface BrowserFromSessionOptions {
  blockImages?: boolean; // Block image downloads, defaults to true
}

export interface BrowserFromSessionResult {
  browser: Browser;
  createContext: (options?: any) => Promise<BrowserContext>;
  cleanup: () => Promise<void>;
}

/**
 * Create a Playwright browser instance from a session
 */
export async function createBrowserFromSession(
  session: Session,
  options: BrowserFromSessionOptions = {}
): Promise<BrowserFromSessionResult> {
  const blockImages = options.blockImages ?? true;
  let browser: Browser;

  if (session.provider === 'browserbase') {
    if (!session.browserbase) {
      throw new Error('Invalid session: missing browserbase data');
    }
    
    // Connect to Browserbase via CDP
    browser = await chromium.connectOverCDP(session.browserbase.connectUrl);
  } else if (session.provider === 'local') {
    if (!session.local) {
      throw new Error('Invalid session: missing local data');
    }
    
    // Use the browser from the session
    browser = session.local.browser;
  } else {
    throw new Error(`Unknown session provider: ${session.provider}`);
  }

  // Create a custom context creator that handles proxy and image blocking
  const createContext = async (contextOptions: any = {}) => {
    // For local browser, add proxy if it was provided in the session
    if (session.provider === 'local' && session.local?.proxy) {
      contextOptions = {
        ...contextOptions,
        proxy: formatProxyForPlaywright(session.local.proxy)
      };
    }

    const context = await browser.newContext(contextOptions);

    // Add image blocking if requested
    if (blockImages) {
      await context.route('**/*', (route) => {
        const request = route.request();
        const resourceType = request.resourceType();
        if (resourceType === 'image') {
          route.abort();
        } else {
          route.continue();
        }
      });
    }

    return context;
  };

  return {
    browser,
    createContext,
    cleanup: async () => {
      await browser.close();
      await session.cleanup();
    }
  };
}