import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SiteManager } from '../src/services/site-manager.js';
import type { SiteConfig } from '../src/types/site-config-types.js';
import type { PartialScrapeRun, PaginationState } from '../src/types/robust-scrape-run.js';

// Mock the drivers
vi.mock('../src/drivers/scrape-runs.js', () => ({
  getSites: vi.fn().mockResolvedValue([]),
  createRun: vi.fn(),
  getRun: vi.fn(),
  listRuns: vi.fn(),
  updateRunItem: vi.fn(),
  finalizeRun: vi.fn(),
  getLatestRunForDomain: vi.fn(),
  fetchRun: vi.fn()
}));

vi.mock('../src/drivers/site-config.js', () => ({
  getSiteConfig: vi.fn()
}));

vi.mock('../src/drivers/proxy.js', () => ({
  getSessionLimitForDomain: vi.fn().mockResolvedValue(2),
  selectProxyForDomain: vi.fn(),
  getProxyStrategy: vi.fn().mockResolvedValue({
    strategy: 'datacenter',
    geo: 'US',
    cooldownMinutes: 30,
    failureThreshold: 2,
    sessionLimit: 2
  })
}));

import { createRun } from '../src/drivers/scrape-runs.js';
const mockCreateRun = createRun as any;

describe('Robust Scrape Runs', () => {
  let siteManager: SiteManager;
  
  const mockSiteConfig: SiteConfig = {
    domain: 'test.com',
    scraper: 'test-scraper',
    startPages: ['https://test.com/page1', 'https://test.com/page2'],
    scraping: {
      browser: {
        ignoreHttpsErrors: true,
        headers: {}
      }
    },
    proxy: {
      strategy: 'datacenter',
      geo: 'US',
      cooldownMinutes: 30,
      failureThreshold: 2,
      sessionLimit: 2
    }
  };

  beforeEach(() => {
    siteManager = new SiteManager();
    siteManager.addSite('test.com', mockSiteConfig);
    vi.clearAllMocks();
  });

  describe('Partial Run Tracking', () => {
    it('should start pagination tracking for a site', async () => {
      await siteManager.startPagination('test.com', mockSiteConfig.startPages);
      
      // Verify internal state was initialized (we can't access private properties directly)
      // So we'll test the behavior instead
      expect(() => {
        siteManager.updatePaginationState('https://test.com/page1', { completed: true });
      }).not.toThrow();
    });

    it('should update pagination state for a start page', async () => {
      await siteManager.startPagination('test.com', mockSiteConfig.startPages);
      
      const collectedUrls = ['https://test.com/item1', 'https://test.com/item2'];
      siteManager.updatePaginationState('https://test.com/page1', {
        collectedUrls,
        completed: true
      });
      
      // Test that update doesn't throw
      expect(() => {
        siteManager.updatePaginationState('https://test.com/page1', {
          failureCount: 1,
          failureHistory: [{
            timestamp: new Date(),
            proxy: 'proxy1',
            error: 'Network error'
          }]
        });
      }).not.toThrow();
    });

    it('should throw error when updating state without starting pagination', () => {
      expect(() => {
        siteManager.updatePaginationState('https://test.com/page1', { completed: true });
      }).toThrow('No partial run found containing start page https://test.com/page1');
    });

    it('should throw error when updating state for unknown start page', async () => {
      await siteManager.startPagination('test.com', mockSiteConfig.startPages);
      
      expect(() => {
        siteManager.updatePaginationState('https://unknown.com/page', { completed: true });
      }).toThrow('No partial run found containing start page https://unknown.com/page');
    });

    it('should commit partial run when all paginations complete successfully', async () => {
      mockCreateRun.mockResolvedValue({
        id: 'run-123',
        domain: 'test.com',
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        items: []
      });

      await siteManager.startPagination('test.com', mockSiteConfig.startPages);
      
      // Complete both paginations with URLs
      siteManager.updatePaginationState('https://test.com/page1', {
        collectedUrls: ['https://test.com/item1', 'https://test.com/item2'],
        completed: true
      });
      
      siteManager.updatePaginationState('https://test.com/page2', {
        collectedUrls: ['https://test.com/item3', 'https://test.com/item4'],
        completed: true
      });
      
      const run = await siteManager.commitPartialRun('test.com');
      
      expect(mockCreateRun).toHaveBeenCalledWith({
        domain: 'test.com',
        urls: [
          'https://test.com/item1',
          'https://test.com/item2',
          'https://test.com/item3',
          'https://test.com/item4'
        ]
      });
      expect(run.id).toBe('run-123');
    });

    it('should throw error when committing with 0 URLs from any pagination', async () => {
      await siteManager.startPagination('test.com', mockSiteConfig.startPages);
      
      // One pagination returns URLs, another returns 0
      siteManager.updatePaginationState('https://test.com/page1', {
        collectedUrls: ['https://test.com/item1'],
        completed: true
      });
      
      siteManager.updatePaginationState('https://test.com/page2', {
        collectedUrls: [],
        completed: true
      });
      
      await expect(siteManager.commitPartialRun('test.com')).rejects.toThrow('Pagination returned 0 URLs - aborting entire run');
    });

    it('should throw error when committing with incomplete paginations', async () => {
      await siteManager.startPagination('test.com', mockSiteConfig.startPages);
      
      // Only complete one pagination
      siteManager.updatePaginationState('https://test.com/page1', {
        collectedUrls: ['https://test.com/item1'],
        completed: true
      });
      
      await expect(siteManager.commitPartialRun('test.com')).rejects.toThrow('Not all paginations completed successfully');
    });

    it('should throw error when committing without partial run', async () => {
      await expect(siteManager.commitPartialRun('test.com')).rejects.toThrow('No partial run to commit for site test.com');
    });

    it('should support multiple sites with independent partial runs', async () => {
      // Add another site
      siteManager.addSite('example.com', {
        ...mockSiteConfig,
        domain: 'example.com',
        startPages: ['https://example.com/page1']
      });

      // Start pagination for both sites
      await siteManager.startPagination('test.com', mockSiteConfig.startPages);
      await siteManager.startPagination('example.com', ['https://example.com/page1']);

      // Verify both sites have partial runs
      expect(siteManager.hasPartialRun('test.com')).toBe(true);
      expect(siteManager.hasPartialRun('example.com')).toBe(true);
      expect(siteManager.getSitesWithPartialRuns()).toHaveLength(2);

      // Complete test.com pagination
      siteManager.updatePaginationState('https://test.com/page1', {
        collectedUrls: ['https://test.com/item1'],
        completed: true
      });
      siteManager.updatePaginationState('https://test.com/page2', {
        collectedUrls: ['https://test.com/item2'],
        completed: true
      });

      mockCreateRun.mockResolvedValue({
        id: 'run-123',
        domain: 'test.com',
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        items: []
      });

      // Commit test.com
      await siteManager.commitPartialRun('test.com');

      // Verify test.com is committed but example.com still has partial run
      expect(siteManager.hasPartialRun('test.com')).toBe(false);
      expect(siteManager.hasPartialRun('example.com')).toBe(true);
      expect(siteManager.getSitesWithPartialRuns()).toEqual(['example.com']);

      // Example.com can still be updated independently
      expect(() => {
        siteManager.updatePaginationState('https://example.com/page1', {
          collectedUrls: ['https://example.com/item1'],
          completed: true
        });
      }).not.toThrow();
    });
  });

  describe('Proxy Blocklist Management', () => {
    it('should add datacenter proxy to blocklist', async () => {
      await siteManager.addProxyToBlocklist('test.com', 'datacenter-proxy-1', 'Connection timeout');
      
      const blockedProxies = await siteManager.getBlockedProxies('test.com');
      expect(blockedProxies).toContain('datacenter-proxy-1');
    });

    it('should not add residential proxy to blocklist', async () => {
      await siteManager.addProxyToBlocklist('test.com', 'residential-proxy-1', 'Connection timeout');
      
      const blockedProxies = await siteManager.getBlockedProxies('test.com');
      expect(blockedProxies).not.toContain('residential-proxy-1');
    });

    it('should increment failure count for existing proxy', async () => {
      await siteManager.addProxyToBlocklist('test.com', 'datacenter-proxy-1', 'Error 1');
      await siteManager.addProxyToBlocklist('test.com', 'datacenter-proxy-1', 'Error 2');
      
      const blockedProxies = await siteManager.getBlockedProxies('test.com');
      expect(blockedProxies).toContain('datacenter-proxy-1');
      expect(blockedProxies).toHaveLength(1);
    });

    it('should return empty array for unknown domain', async () => {
      const blockedProxies = await siteManager.getBlockedProxies('unknown.com');
      expect(blockedProxies).toEqual([]);
    });

    it('should auto-cleanup expired blocked proxies', async () => {
      const site = siteManager.getSite('test.com');
      if (!site) throw new Error('Site not found');
      
      // Add a proxy with expired timestamp (31 minutes ago)
      const expiredTime = new Date();
      expiredTime.setMinutes(expiredTime.getMinutes() - 31);
      
      site.proxyBlocklist.set('datacenter-proxy-1', {
        proxy: 'datacenter-proxy-1',
        failedAt: expiredTime,
        failureCount: 1,
        lastError: 'Old error'
      });
      
      // Add a recent proxy
      await siteManager.addProxyToBlocklist('test.com', 'datacenter-proxy-2', 'Recent error');
      
      const blockedProxies = await siteManager.getBlockedProxies('test.com');
      expect(blockedProxies).not.toContain('datacenter-proxy-1'); // Should be cleaned up
      expect(blockedProxies).toContain('datacenter-proxy-2'); // Should remain
    });
  });

  describe('getSiteConfigsWithBlockedProxies', () => {
    it('should return configs with blocked proxies by default', async () => {
      await siteManager.addProxyToBlocklist('test.com', 'datacenter-proxy-1', 'Error');
      
      const configs = await siteManager.getSiteConfigsWithBlockedProxies();
      expect(configs).toHaveLength(1);
      expect(configs[0].domain).toBe('test.com');
      expect(configs[0].blockedProxies).toEqual(['datacenter-proxy-1']);
    });

    it('should return configs without blocked proxies when requested', async () => {
      await siteManager.addProxyToBlocklist('test.com', 'datacenter-proxy-1', 'Error');
      
      const configs = await siteManager.getSiteConfigsWithBlockedProxies(false);
      expect(configs).toHaveLength(1);
      expect(configs[0].domain).toBe('test.com');
      expect(configs[0].blockedProxies).toBeUndefined();
    });

    it('should handle multiple sites with different blocked proxies', async () => {
      siteManager.addSite('example.com', {
        ...mockSiteConfig,
        domain: 'example.com'
      });
      
      await siteManager.addProxyToBlocklist('test.com', 'datacenter-proxy-1', 'Error');
      await siteManager.addProxyToBlocklist('example.com', 'datacenter-proxy-2', 'Error');
      
      const configs = await siteManager.getSiteConfigsWithBlockedProxies();
      expect(configs).toHaveLength(2);
      
      const testConfig = configs.find(c => c.domain === 'test.com');
      const exampleConfig = configs.find(c => c.domain === 'example.com');
      
      expect(testConfig?.blockedProxies).toEqual(['datacenter-proxy-1']);
      expect(exampleConfig?.blockedProxies).toEqual(['datacenter-proxy-2']);
    });
  });
});