import { describe, it, expect, beforeEach } from 'vitest';
import { 
  loadProxies, 
  loadProxyStrategies, 
  loadDatabaseFile,
  clearCache 
} from '../src/providers/local-db.js';

describe('local-db provider', () => {
  beforeEach(() => {
    // Clear cache before each test
    clearCache();
  });

  describe('loadProxies', () => {
    it('should load proxies.json successfully', async () => {
      const proxyStore = await loadProxies();
      
      expect(proxyStore).toBeDefined();
      expect(proxyStore.proxies).toBeDefined();
      expect(Array.isArray(proxyStore.proxies)).toBe(true);
      expect(proxyStore.default).toBeDefined();
      expect(typeof proxyStore.default).toBe('string');
    });

    it('should return cached data on second call', async () => {
      // First call
      const store1 = await loadProxies();
      // Second call should return same reference
      const store2 = await loadProxies();
      
      expect(store1).toBe(store2);
    });
  });

  describe('loadProxyStrategies', () => {
    it('should load proxy-strategies.json successfully', async () => {
      const strategies = await loadProxyStrategies();
      
      expect(strategies).toBeDefined();
      expect(typeof strategies).toBe('object');
      // Should have at least a default strategy
      expect(strategies.default).toBeDefined();
      expect(strategies.default.strategy).toBeDefined();
      expect(strategies.default.geo).toBeDefined();
      expect(strategies.default.cooldownMinutes).toBeDefined();
      expect(strategies.default.failureThreshold).toBeDefined();
      expect(strategies.default.sessionLimit).toBeDefined();
    });
  });

  describe('loadDatabaseFile', () => {
    it('should load arbitrary JSON files', async () => {
      const proxies = await loadDatabaseFile('proxies.json');
      expect(proxies).toBeDefined();
    });

    it('should throw error for non-existent files', async () => {
      await expect(loadDatabaseFile('non-existent-file.json'))
        .rejects.toThrow('Failed to load database file');
    });
  });

  describe('clearCache', () => {
    it('should clear specific file from cache', async () => {
      // Load file first
      const store1 = await loadProxies();
      // Clear specific cache
      clearCache('proxies.json');
      // Next load should be fresh (different reference)
      const store2 = await loadProxies();
      
      // Since we cleared cache, these should be different objects
      // but with same content
      expect(store1).not.toBe(store2);
      expect(store1).toEqual(store2);
    });

    it('should clear all cache when no filename provided', async () => {
      // Load multiple files
      await loadProxies();
      await loadProxyStrategies();
      
      // Clear all cache
      clearCache();
      
      // Both should load fresh
      const proxies = await loadProxies();
      const strategies = await loadProxyStrategies();
      
      expect(proxies).toBeDefined();
      expect(strategies).toBeDefined();
    });
  });
});