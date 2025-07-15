import type { Proxy, ProxyStore, PlaywrightProxy } from '../types/proxy.js';
import { loadProxies as loadProxiesFromDb } from '../providers/local-db.js';

/**
 * Load all proxies from proxies.json
 * This function now delegates to the local-db provider
 */
export async function loadProxies(): Promise<ProxyStore> {
  return loadProxiesFromDb();
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