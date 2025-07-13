import { readFile } from 'fs/promises';
import { join } from 'path';
import type { Proxy, ProxyStore, PlaywrightProxy } from '../types/proxy.js';

let cachedStore: ProxyStore | null = null;

/**
 * Load all proxies from proxies.json
 */
export async function loadProxies(): Promise<ProxyStore> {
  if (cachedStore) {
    return cachedStore;
  }

  const proxyPath = join(process.cwd(), 'db', 'proxies.json');
  const data = await readFile(proxyPath, 'utf-8');
  const store = JSON.parse(data) as ProxyStore;
  
  // Basic validation
  if (!store.proxies || !Array.isArray(store.proxies)) {
    throw new Error('Invalid proxy store: missing proxies array');
  }
  
  if (!store.default || typeof store.default !== 'string') {
    throw new Error('Invalid proxy store: missing default proxy id');
  }

  cachedStore = store;
  return store;
}

/**
 * Get specific proxy by ID
 */
export function getProxyById(store: ProxyStore, id: string): Proxy | null {
  return store.proxies.find(proxy => proxy.id === id) || null;
}

/**
 * Get default proxy
 */
export function getDefaultProxy(store: ProxyStore): Proxy | null {
  return getProxyById(store, store.default);
}

/**
 * Convert proxy to Playwright format
 */
export function formatProxyForPlaywright(proxy: Proxy): PlaywrightProxy {
  return {
    server: proxy.url,
    username: proxy.username,
    password: proxy.password
  };
}