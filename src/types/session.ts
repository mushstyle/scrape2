import type { Browser } from 'playwright';
import type { Proxy } from './proxy.js';

export interface SessionOptions {
  proxy?: Proxy;
  // Future options: timeout, region, etc.
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