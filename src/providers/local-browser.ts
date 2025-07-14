import { chromium } from 'playwright';
import type { Session, SessionOptions, LocalSession } from '../types/session.js';

/**
 * Create a local browser session with optional proxy configuration
 * Note: Proxy is stored for later use when creating contexts
 * @param options.headless - Whether to run browser in headless mode (defaults to false)
 */
export async function createSession(options: SessionOptions = {}): Promise<Session> {
  // Default to headed mode unless explicitly set to headless
  const browser = await chromium.launch({
    headless: options.headless ?? false
  });

  const localSession: LocalSession = {
    browser,
    proxy: options.proxy
  };

  return {
    provider: 'local',
    local: localSession,
    cleanup: async () => {
      await browser.close();
    }
  };
}