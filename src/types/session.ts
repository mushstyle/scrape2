import type { Browser } from 'playwright';
import type { Proxy } from './proxy.js';

export interface SessionOptions {
  proxy?: Proxy;
  headless?: boolean;  // For local browser only, defaults to false
  timeout?: number;    // Session timeout in seconds (browserbase only, defaults to 60)
  // Future options: region, etc.
}

export interface BrowserbaseSession {
  id: string;
  connectUrl: string;
  projectId: string;
}

export interface LocalSession {
  browser: Browser;
  proxy?: Proxy;
}

export interface Session {
  provider: 'browserbase' | 'local';
  browserbase?: BrowserbaseSession;
  local?: LocalSession;
  cleanup: () => Promise<void>;
}