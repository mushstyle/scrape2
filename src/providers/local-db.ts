/**
 * Local Database Provider
 * 
 * This module provides functions to load and manage local JSON database files
 * from the db/ directory. It includes caching to avoid repeated file reads.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { ProxyStore } from '../types/proxy.js';
import type { ProxyStrategiesStore } from '../types/site-config-types.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('local-db');

// Cache for loaded data
const cache = new Map<string, any>();

/**
 * Generic function to load a JSON file from the db directory
 * @param filename - The name of the file to load (e.g., 'proxies.json')
 * @returns The parsed JSON data
 */
async function loadJsonFile<T>(filename: string): Promise<T> {
  // Check cache first
  if (cache.has(filename)) {
    log.debug(`Returning cached data for ${filename}`);
    return cache.get(filename) as T;
  }

  try {
    const filePath = join(process.cwd(), 'db', filename);
    const data = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(data) as T;
    
    // Cache the result
    cache.set(filename, parsed);
    log.debug(`Loaded and cached ${filename}`);
    
    return parsed;
  } catch (error) {
    log.error(`Failed to load ${filename}`, { error });
    throw new Error(`Failed to load database file ${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Clear the cache for a specific file or all files
 * @param filename - Optional filename to clear from cache. If not provided, clears all cache.
 */
export function clearCache(filename?: string): void {
  if (filename) {
    cache.delete(filename);
    log.debug(`Cleared cache for ${filename}`);
  } else {
    cache.clear();
    log.debug('Cleared all cache');
  }
}

/**
 * Load proxies from proxies.json
 */
export async function loadProxies(): Promise<ProxyStore> {
  const store = await loadJsonFile<ProxyStore>('proxies.json');
  
  // Basic validation
  if (!store.proxies || !Array.isArray(store.proxies)) {
    throw new Error('Invalid proxy store: missing proxies array');
  }
  
  if (!store.default || typeof store.default !== 'string') {
    throw new Error('Invalid proxy store: missing default proxy id');
  }
  
  return store;
}

/**
 * Load proxy strategies from proxy-strategies.json
 */
export async function loadProxyStrategies(): Promise<ProxyStrategiesStore> {
  return await loadJsonFile<ProxyStrategiesStore>('proxy-strategies.json');
}

/**
 * Load scrapers configuration from scrapers.json if it exists
 */
export async function loadScrapersConfig(): Promise<Record<string, any>> {
  try {
    return await loadJsonFile<Record<string, any>>('scrapers.json');
  } catch (error) {
    log.debug('No scrapers.json found, this is expected');
    return {};
  }
}

/**
 * Generic loader for any JSON file in the db directory
 * @param filename - The filename to load
 * @returns The parsed JSON data
 */
export async function loadDatabaseFile<T = any>(filename: string): Promise<T> {
  return loadJsonFile<T>(filename);
}