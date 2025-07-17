/**
 * Proxy Driver
 * 
 * Comprehensive proxy management including:
 * - Loading proxy configurations
 * - Strategy-based proxy selection for domains
 * - Proxy formatting for browser providers
 */

import type { Proxy, ProxyStore, PlaywrightProxy } from '../types/proxy.js';
import type { ProxyStrategy, ProxyStrategiesStore } from '../types/site-config-types.js';
import { loadProxies as loadProxiesFromDb, loadProxyStrategies } from '../providers/local-db.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('proxy-driver');

// Cache for loaded data
let proxiesCache: ProxyStore | null = null;
let strategiesCache: ProxyStrategiesStore | null = null;

/**
 * Load all proxies from proxies.json
 */
export async function loadProxies(): Promise<ProxyStore> {
  if (!proxiesCache) {
    proxiesCache = await loadProxiesFromDb();
  }
  return proxiesCache;
}

/**
 * Get proxy strategy for a domain
 * @param domain - The domain to get strategy for
 * @returns The proxy strategy or default strategy
 */
export async function getProxyStrategy(domain: string): Promise<ProxyStrategy> {
  if (!strategiesCache) {
    strategiesCache = await loadProxyStrategies();
  }
  
  const strategy = strategiesCache[domain] || strategiesCache.default;
  if (!strategy) {
    throw new Error('No default proxy strategy found');
  }
  
  log.debug(`Strategy for ${domain}: ${strategy.strategy}`);
  return strategy;
}

/**
 * Select a proxy based on domain and strategy
 * @param domain - The domain to select proxy for
 * @returns Selected proxy or null if no proxy should be used
 */
export async function selectProxyForDomain(domain: string): Promise<Proxy | null> {
  // Get strategy for domain
  const strategy = await getProxyStrategy(domain);
  
  // Load proxies if not cached
  const proxyStore = await loadProxies();
  
  // Filter proxies based on strategy
  const candidateProxies = proxyStore.proxies.filter(proxy => {
    // Match proxy type to strategy
    if (strategy.strategy === 'datacenter' && proxy.type !== 'datacenter') {
      return false;
    }
    if (strategy.strategy === 'residential-rotating' && proxy.type !== 'residential') {
      return false;
    }
    
    // Match geo if specified
    if (strategy.geo && proxy.geo !== strategy.geo) {
      return false;
    }
    
    return true;
  });
  
  if (candidateProxies.length === 0) {
    log.error(`No proxies found for strategy: ${strategy.strategy}, geo: ${strategy.geo}`);
    return null;
  }
  
  // For now, select a random proxy from candidates
  // In production, this could consider proxy health, usage, etc.
  const selected = candidateProxies[Math.floor(Math.random() * candidateProxies.length)];
  
  log.debug(`Selected proxy ${selected.id} for ${domain} (${strategy.strategy})`);
  return selected;
}

/**
 * Get session limit for a domain from its proxy strategy
 * @param domain - The domain to get session limit for
 * @returns The session limit
 */
export async function getSessionLimitForDomain(domain: string): Promise<number> {
  const strategy = await getProxyStrategy(domain);
  return strategy.sessionLimit || 1;
}

/**
 * Get specific proxy by ID
 */
export async function getProxyById(id: string): Promise<Proxy | null> {
  const store = await loadProxies();
  return store.proxies.find(proxy => proxy.id === id) || null;
}

/**
 * Get default proxy
 */
export async function getDefaultProxy(): Promise<Proxy | null> {
  const store = await loadProxies();
  return getProxyById(store.default);
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

/**
 * Clear cached data (useful for testing)
 */
export function clearCache(): void {
  proxiesCache = null;
  strategiesCache = null;
}