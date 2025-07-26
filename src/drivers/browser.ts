import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import type { Session } from '../types/session.js';
import { formatProxyForPlaywright } from './proxy.js';
import { createSession as createBrowserbaseSessionProvider } from '../providers/browserbase.js';
import { createSession as createLocalSessionProvider } from '../providers/local-browser.js';
import type { RequestCache } from './cache.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('browser');

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
      
      // Add error handlers to prevent crashes when browser disconnects
      const sessionId = session.browserbase.id;
      
      browser.on('disconnected', () => {
        // Log but don't throw - this is expected when sessions expire
        log.error(`Browser disconnected for session ${sessionId}`);
        // Mark browser as disconnected to trigger recreation on next use
        (browser as any)._isDisconnected = true;
      });
      
      // Catch any errors emitted by the browser
      browser.on('error', (error) => {
        log.error(`Browser error for session ${sessionId}:`, error.message);
      });
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
    
    // Add error handlers for local browser too
    browser.on('disconnected', () => {
      log.error('Local browser disconnected');
    });
    
    browser.on('error', (error) => {
      log.error('Local browser error:', error.message);
    });
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
    
    // Add error handler to prevent crashes from disconnected contexts
    context.on('error', (error) => {
      log.error('Browser context error:', error.message);
    });
    
    // Listen for context close events
    context.on('close', () => {
      log.debug('Browser context closed');
    });

    // Image blocking removed - now handled by RequestCache
    // The blockImages option is deprecated and will be removed in a future version
    if (blockImages) {
      log.debug('blockImages option is deprecated. Image blocking is now handled by RequestCache.');
    }

    return context;
  };

  // Add a custom isConnected method that checks our disconnect flag
  (browser as any).isConnectedSafe = () => {
    return browser.isConnected() && !(browser as any)._isDisconnected;
  };

  return {
    browser,
    createContext,
    cleanup: async () => {
      await browser.close();
      // Don't call session.cleanup() here - let SessionManager handle session lifecycle
      // await session.cleanup();
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