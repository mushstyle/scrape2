import { chromium } from 'playwright';
import type { Session, SessionOptions, LocalSession } from '../types/session.js';

/**
 * Create a local browser session with optional proxy configuration
 * Note: Proxy is stored for later use when creating contexts
 */
export async function createSession(options: SessionOptions = {}): Promise<Session> {
  // Local browser is always headed
  const browser = await chromium.launch({
    headless: false
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