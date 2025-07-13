import type { Browser } from 'playwright';

export interface BrowserOptions {
  provider: 'browserbase' | 'local';
  sessionId?: string; // Required for browserbase
  headless?: boolean; // Always false for local
  blockImages?: boolean; // Block image downloads, defaults to true
}

export interface BrowserResult {
  browser: Browser;
  cleanup: () => Promise<void>;
}