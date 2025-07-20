import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import type { Session } from '../types/session.js';
import { formatProxyForPlaywright } from './proxy.js';
import { createSession as createBrowserbaseSessionProvider } from '../providers/browserbase.js';
import { createSession as createLocalSessionProvider } from '../providers/local-browser.js';
import { UnifiedRouteHandler } from './unified-route-handler.js';
import type { RequestCache } from './cache.js';

export interface BrowserFromSessionOptions {
  blockImages?: boolean; // Block image downloads, defaults to true
}

export interface BrowserFromSessionResult {
  browser: Browser;
  createContext: (options?: BrowserContextOptions) => Promise<BrowserContext>;
  cleanup: () => Promise<void>;
}

export interface BrowserContextOptions {
  cache?: RequestCache;
  [key: string]: any;
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
    
    // Connect to Browserbase via CDP with better error handling
    try {
      browser = await chromium.connectOverCDP(session.browserbase.connectUrl);
    } catch (error: any) {
      // Add session ID to error message for better debugging
      const sessionId = session.browserbase.id;
      if (error.message?.includes('Could not find a running session')) {
        throw new Error(`Browserbase session ${sessionId} not found or expired: ${error.message}`);
      }
      throw new Error(`Failed to connect to browserbase session ${sessionId}: ${error.message}`);
    }
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
    // Note: Cache handler is added separately and takes priority
    if (blockImages) {
      await context.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico}', async (route) => {
        try {
          await route.abort();
        } catch (error: any) {
          // Ignore errors - route might be handled by another handler
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

/**
 * Create a Browserbase session (wrapper for provider)
 */
export async function createBrowserbaseSession(options: { proxy?: any } = {}): Promise<Session> {
  return createBrowserbaseSessionProvider(options);
}

/**
 * Create a local browser session (wrapper for provider)
 */
export async function createLocalSession(options: { proxy?: any } = {}): Promise<Session> {
  return createLocalSessionProvider(options);
}

/**
 * Terminate a session properly
 * This abstracts the termination logic for different providers
 */
export async function terminateSession(session: Session): Promise<void> {
  // Call the session's cleanup function which handles provider-specific termination
  await session.cleanup();
}