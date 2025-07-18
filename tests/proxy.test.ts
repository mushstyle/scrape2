import { describe, it, expect, beforeEach } from 'vitest';
import { 
  getProxyStrategy, 
  selectProxyForDomain, 
  getSessionLimitForDomain,
  clearCache 
} from '../src/drivers/proxy.js';

describe('Proxy Driver', () => {
  beforeEach(() => {
    // Clear cache before each test
    clearCache();
  });

  describe('getProxyStrategy', () => {
    it('should return strategy for known domain', async () => {
      const strategy = await getProxyStrategy('amgbrand.com');
      expect(strategy).toBeDefined();
      expect(strategy.strategy).toBe('datacenter');
      expect(strategy.geo).toBe('US');
      expect(strategy.sessionLimit).toBe(4);
    });

    it('should return default strategy for unknown domain', async () => {
      const strategy = await getProxyStrategy('unknown-domain.com');
      expect(strategy).toBeDefined();
      expect(strategy.strategy).toBe('datacenter');
      expect(strategy.geo).toBe('US');
      expect(strategy.sessionLimit).toBe(3);
    });

    it('should return iam-store.com strategy', async () => {
      const strategy = await getProxyStrategy('iam-store.com');
      expect(strategy).toBeDefined();
      expect(strategy.strategy).toBe('residential-rotating');
      expect(strategy.sessionLimit).toBe(3);
    });
  });

  describe('selectProxyForDomain', () => {
    it('should select datacenter proxy for default strategy', async () => {
      const proxy = await selectProxyForDomain('unknown-domain.com');
      expect(proxy).toBeDefined();
      expect(proxy?.type).toBe('datacenter');
      expect(proxy?.geo).toBe('US');
    });

    it('should select datacenter proxy for amgbrand.com', async () => {
      const proxy = await selectProxyForDomain('amgbrand.com');
      expect(proxy).toBeDefined();
      expect(proxy?.type).toBe('datacenter');
      expect(proxy?.geo).toBe('US');
    });

    it('should select residential proxy for iam-store.com', async () => {
      const proxy = await selectProxyForDomain('iam-store.com');
      expect(proxy).toBeDefined();
      expect(proxy?.type).toBe('residential');
      expect(proxy?.geo).toBe('US');
      expect(proxy?.provider).toBe('oxylabs');
    });

    it('should select datacenter proxy for katimoclothes.com', async () => {
      const proxy = await selectProxyForDomain('katimoclothes.com');
      expect(proxy).toBeDefined();
      expect(proxy?.type).toBe('datacenter');
      expect(proxy?.geo).toBe('US');
    });
  });

  describe('getSessionLimitForDomain', () => {
    it('should return session limit for known domain', async () => {
      const limit = await getSessionLimitForDomain('amgbrand.com');
      expect(limit).toBe(4);
    });

    it('should return session limit for iam-store.com', async () => {
      const limit = await getSessionLimitForDomain('iam-store.com');
      expect(limit).toBe(3);
    });

    it('should return default session limit for unknown domain', async () => {
      const limit = await getSessionLimitForDomain('unknown-domain.com');
      expect(limit).toBe(3);
    });
  });

  describe('proxy selection consistency', () => {
    it('should use cached data on subsequent calls', async () => {
      // First call loads from file
      const strategy1 = await getProxyStrategy('amgbrand.com');
      
      // Second call should use cache
      const strategy2 = await getProxyStrategy('amgbrand.com');
      
      expect(strategy1).toEqual(strategy2);
    });

    it('should select appropriate proxy type based on strategy', async () => {
      // Test multiple domains to ensure correct proxy type selection
      const testCases = [
        { domain: 'amgbrand.com', expectedType: 'datacenter' },
        { domain: 'iam-store.com', expectedType: 'residential' },
        { domain: 'katimoclothes.com', expectedType: 'datacenter' },
        { domain: 'ivaclothe.com', expectedType: 'datacenter' },
        { domain: 'cos.com', expectedType: 'residential' }
      ];

      for (const { domain, expectedType } of testCases) {
        const proxy = await selectProxyForDomain(domain);
        expect(proxy).toBeDefined();
        expect(proxy?.type).toBe(expectedType);
      }
    });
  });
});