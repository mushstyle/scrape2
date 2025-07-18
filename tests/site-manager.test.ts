import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SiteManager } from '../src/services/site-manager.js';
import type { SiteConfig, SiteConfigWithBlockedProxies } from '../src/types/site-config-types.js';
import type { ScrapeRun } from '../src/types/scrape-run.js';

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
  }),
  loadProxies: vi.fn().mockResolvedValue({
    datacenter: [
      { id: 'dc-proxy-1', type: 'datacenter', geo: 'US' },
      { id: 'dc-proxy-2', type: 'datacenter', geo: 'UK' }
    ],
    residential: [
      { id: 'res-proxy-1', type: 'residential', geo: 'US' }
    ]
  }),
  getProxyById: vi.fn()
}));

import { createRun } from '../src/drivers/scrape-runs.js';
import { getSiteConfig } from '../src/drivers/site-config.js';
import { loadProxies, getProxyById } from '../src/drivers/proxy.js';

const mockCreateRun = createRun as any;
const mockGetSiteConfig = getSiteConfig as any;
const mockLoadProxies = loadProxies as any;
const mockGetProxyById = getProxyById as any;

describe('SiteManager', () => {
  let manager: SiteManager;
  
  const createMockSiteConfig = (domain: string, overrides?: Partial<SiteConfig>): SiteConfig => ({
    domain,
    scraper: `${domain}-scraper`,
    startPages: [`https://${domain}/page1`, `https://${domain}/page2`],
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
    },
    ...overrides
  });

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SiteManager();
  });

  afterEach(() => {
    // Clean up any remaining state
    manager = null as any;
  });

  describe('Site Management', () => {
    it('should add and retrieve sites', () => {
      const config = createMockSiteConfig('test.com');
      
      manager.addSite('test.com', config);
      
      const retrieved = manager.getSite('test.com');
      expect(retrieved).toBeDefined();
      expect(retrieved?.config).toEqual(config);
    });

    it('should get all sites', () => {
      const config1 = createMockSiteConfig('test1.com');
      const config2 = createMockSiteConfig('test2.com');
      
      manager.addSite('test1.com', config1);
      manager.addSite('test2.com', config2);
      
      const sites = manager.getAllSites();
      expect(sites).toHaveLength(2);
      const domains = sites.map(s => s.domain);
      expect(domains).toContain('test1.com');
      expect(domains).toContain('test2.com');
    });

    it('should get site configs with blocked proxies', async () => {
      const config1 = createMockSiteConfig('test1.com');
      const config2 = createMockSiteConfig('test2.com');
      
      manager.addSite('test1.com', config1);
      manager.addSite('test2.com', config2);
      
      // Add blocked proxy to test1.com
      await manager.addProxyToBlocklist('test1.com', 'dc-proxy-1', 'Connection failed');
      
      const configs = await manager.getSiteConfigsWithBlockedProxies();
      expect(configs).toHaveLength(2);
      
      const test1Config = configs.find(c => c.domain === 'test1.com');
      expect(test1Config?.blockedProxies).toEqual(['dc-proxy-1']);
      
      const test2Config = configs.find(c => c.domain === 'test2.com');
      expect(test2Config?.blockedProxies).toEqual([]);
    });

    it('should get site configs without blocked proxies when requested', async () => {
      const config = createMockSiteConfig('test.com');
      manager.addSite('test.com', config);
      
      await manager.addProxyToBlocklist('test.com', 'dc-proxy-1', 'Error');
      
      const configs = await manager.getSiteConfigsWithBlockedProxies(false);
      expect(configs).toHaveLength(1);
      expect(configs[0].blockedProxies).toBeUndefined();
    });
  });

  describe('Proxy Blocklist Management', () => {
    beforeEach(() => {
      const config = createMockSiteConfig('test.com');
      manager.addSite('test.com', config);
    });

    it('should add datacenter proxy to blocklist', async () => {
      mockGetProxyById.mockResolvedValueOnce({ 
        id: 'dc-proxy-1', 
        type: 'datacenter', 
        geo: 'US' 
      });

      await manager.addProxyToBlocklist('test.com', 'dc-proxy-1', 'Connection timeout');
      
      const blockedProxies = await manager.getBlockedProxies('test.com');
      expect(blockedProxies).toContain('dc-proxy-1');
    });

    it('should not add residential proxy to blocklist', async () => {
      // The isDatacenterProxy method checks if proxy contains 'residential'
      await manager.addProxyToBlocklist('test.com', 'residential-proxy-1', 'Connection timeout');
      
      const blockedProxies = await manager.getBlockedProxies('test.com');
      expect(blockedProxies).not.toContain('residential-proxy-1');
    });

    it('should handle proxy not found', async () => {
      // A proxy that is not in a known proxy pool but doesn't contain 'residential'
      // will still be added to blocklist based on current implementation
      await manager.addProxyToBlocklist('test.com', 'unknown-proxy', 'Error');
      
      const blockedProxies = await manager.getBlockedProxies('test.com');
      expect(blockedProxies).toContain('unknown-proxy');
    });

    it('should increment failure count for existing blocked proxy', async () => {
      mockGetProxyById.mockResolvedValue({ 
        id: 'dc-proxy-1', 
        type: 'datacenter', 
        geo: 'US' 
      });

      await manager.addProxyToBlocklist('test.com', 'dc-proxy-1', 'Error 1');
      await manager.addProxyToBlocklist('test.com', 'dc-proxy-1', 'Error 2');
      
      const blockedProxies = await manager.getBlockedProxies('test.com');
      expect(blockedProxies).toContain('dc-proxy-1');
      expect(blockedProxies).toHaveLength(1);
      
      // Verify internal state
      const site = manager.getSite('test.com');
      const blockedProxy = site?.proxyBlocklist.get('dc-proxy-1');
      expect(blockedProxy?.failureCount).toBe(2);
      expect(blockedProxy?.lastError).toBe('Error 2');
    });

    it('should auto-cleanup expired blocked proxies', async () => {
      const site = manager.getSite('test.com');
      if (!site) throw new Error('Site not found');
      
      // Add expired proxy (31 minutes ago)
      const expiredTime = new Date();
      expiredTime.setMinutes(expiredTime.getMinutes() - 31);
      
      site.proxyBlocklist.set('dc-proxy-1', {
        proxy: 'dc-proxy-1',
        failedAt: expiredTime,
        failureCount: 1,
        lastError: 'Old error'
      });
      
      // Add recent proxy
      mockGetProxyById.mockResolvedValueOnce({ 
        id: 'dc-proxy-2', 
        type: 'datacenter', 
        geo: 'US' 
      });
      await manager.addProxyToBlocklist('test.com', 'dc-proxy-2', 'Recent error');
      
      const blockedProxies = await manager.getBlockedProxies('test.com');
      expect(blockedProxies).not.toContain('dc-proxy-1'); // Cleaned up
      expect(blockedProxies).toContain('dc-proxy-2'); // Still blocked
    });

    it('should return empty array for unknown domain', async () => {
      const blockedProxies = await manager.getBlockedProxies('unknown.com');
      expect(blockedProxies).toEqual([]);
    });

    it('should handle concurrent proxy blocklist updates', async () => {
      mockGetProxyById.mockImplementation((id: string) => {
        if (id.startsWith('dc-')) {
          return Promise.resolve({ id, type: 'datacenter', geo: 'US' });
        }
        return Promise.resolve(null);
      });

      // Add multiple proxies concurrently
      const promises = Array.from({ length: 5 }, (_, i) => 
        manager.addProxyToBlocklist('test.com', `dc-proxy-${i}`, `Error ${i}`)
      );

      await Promise.all(promises);

      const blockedProxies = await manager.getBlockedProxies('test.com');
      expect(blockedProxies).toHaveLength(5);
      
      // Verify all were added
      for (let i = 0; i < 5; i++) {
        expect(blockedProxies).toContain(`dc-proxy-${i}`);
      }
    });
  });

  describe('Partial Run Management', () => {
    beforeEach(() => {
      const config = createMockSiteConfig('test.com');
      manager.addSite('test.com', config);
    });

    it('should start pagination tracking', async () => {
      const startPages = ['https://test.com/page1', 'https://test.com/page2'];
      
      await manager.startPagination('test.com', startPages);
      
      expect(manager.hasPartialRun('test.com')).toBe(true);
      expect(manager.getSitesWithPartialRuns()).toEqual(['test.com']);
    });

    it('should update pagination state for start page', async () => {
      const startPages = ['https://test.com/page1'];
      await manager.startPagination('test.com', startPages);
      
      const collectedUrls = ['https://test.com/item1', 'https://test.com/item2'];
      manager.updatePaginationState('https://test.com/page1', {
        collectedUrls,
        completed: true
      });
      
      // Should not throw
      expect(() => {
        manager.updatePaginationState('https://test.com/page1', {
          failureCount: 1,
          failureHistory: [{
            timestamp: new Date(),
            proxy: 'proxy1',
            error: 'Network error'
          }]
        });
      }).not.toThrow();
    });

    it('should throw when updating without starting pagination', () => {
      expect(() => {
        manager.updatePaginationState('https://test.com/page1', { completed: true });
      }).toThrow('No partial run found containing start page https://test.com/page1');
    });

    it('should commit partial run when all paginations complete', async () => {
      mockCreateRun.mockResolvedValueOnce({
        id: 'run-123',
        domain: 'test.com',
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        items: []
      });

      const startPages = ['https://test.com/page1', 'https://test.com/page2'];
      await manager.startPagination('test.com', startPages);
      
      // Complete both paginations with URLs
      manager.updatePaginationState('https://test.com/page1', {
        collectedUrls: ['https://test.com/item1', 'https://test.com/item2'],
        completed: true
      });
      
      manager.updatePaginationState('https://test.com/page2', {
        collectedUrls: ['https://test.com/item3', 'https://test.com/item4'],
        completed: true
      });
      
      const run = await manager.commitPartialRun('test.com');
      
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
      
      // Partial run should be cleaned up
      expect(manager.hasPartialRun('test.com')).toBe(false);
    });

    it('should abort when any pagination returns 0 URLs', async () => {
      const startPages = ['https://test.com/page1', 'https://test.com/page2'];
      await manager.startPagination('test.com', startPages);
      
      manager.updatePaginationState('https://test.com/page1', {
        collectedUrls: ['https://test.com/item1'],
        completed: true
      });
      
      manager.updatePaginationState('https://test.com/page2', {
        collectedUrls: [],
        completed: true
      });
      
      await expect(manager.commitPartialRun('test.com'))
        .rejects.toThrow('Pagination returned 0 URLs - aborting entire run');
      
      // Partial run is NOT cleaned up on error (per actual implementation)
      expect(manager.hasPartialRun('test.com')).toBe(true);
    });

    it('should throw when committing with incomplete paginations', async () => {
      const startPages = ['https://test.com/page1', 'https://test.com/page2'];
      await manager.startPagination('test.com', startPages);
      
      // Only complete one pagination
      manager.updatePaginationState('https://test.com/page1', {
        collectedUrls: ['https://test.com/item1'],
        completed: true
      });
      
      await expect(manager.commitPartialRun('test.com'))
        .rejects.toThrow('Not all paginations completed successfully');
    });

    it('should handle multiple sites with independent partial runs', async () => {
      // Add another site
      const config2 = createMockSiteConfig('example.com');
      manager.addSite('example.com', config2);
      
      // Start pagination for both sites
      await manager.startPagination('test.com', ['https://test.com/page1']);
      await manager.startPagination('example.com', ['https://example.com/page1']);
      
      expect(manager.getSitesWithPartialRuns()).toHaveLength(2);
      expect(manager.hasPartialRun('test.com')).toBe(true);
      expect(manager.hasPartialRun('example.com')).toBe(true);
      
      // Complete test.com
      manager.updatePaginationState('https://test.com/page1', {
        collectedUrls: ['https://test.com/item1'],
        completed: true
      });
      
      mockCreateRun.mockResolvedValueOnce({
        id: 'run-test',
        domain: 'test.com',
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        items: []
      });
      
      await manager.commitPartialRun('test.com');
      
      // Only example.com should have partial run
      expect(manager.hasPartialRun('test.com')).toBe(false);
      expect(manager.hasPartialRun('example.com')).toBe(true);
      expect(manager.getSitesWithPartialRuns()).toEqual(['example.com']);
    });

    it('should handle pagination state lifecycle correctly', async () => {
      const startPages = ['https://test.com/page1'];
      await manager.startPagination('test.com', startPages);
      
      // Track state changes
      manager.updatePaginationState('https://test.com/page1', {
        collectedUrls: ['https://test.com/item1'],
        failureCount: 1
      });
      
      // Add more URLs
      manager.updatePaginationState('https://test.com/page1', {
        collectedUrls: ['https://test.com/item2', 'https://test.com/item3']
      });
      
      // Complete pagination
      manager.updatePaginationState('https://test.com/page1', {
        completed: true
      });
      
      mockCreateRun.mockResolvedValueOnce({
        id: 'run-123',
        domain: 'test.com',
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        items: []
      });
      
      const run = await manager.commitPartialRun('test.com');
      
      // URLs are collected per pagination state, last update wins
      // Since we updated with [item2, item3] last, only those are included
      expect(mockCreateRun).toHaveBeenCalledWith({
        domain: 'test.com',
        urls: ['https://test.com/item2', 'https://test.com/item3']
      });
    });
  });

  describe('Scrape Run Management', () => {
    beforeEach(() => {
      const config = createMockSiteConfig('test.com');
      manager.addSite('test.com', config);
    });

    it('should create pending run', async () => {
      const mockRun: ScrapeRun = {
        id: 'run-123',
        domain: 'test.com',
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        items: []
      };
      
      mockCreateRun.mockResolvedValueOnce(mockRun);
      
      const run = await manager.createRun('test.com', ['https://test.com/url1']);
      
      expect(mockCreateRun).toHaveBeenCalledWith({
        domain: 'test.com',
        urls: ['https://test.com/url1']
      });
      expect(run).toEqual(mockRun);
    });

    it('should handle run creation failure', async () => {
      mockCreateRun.mockRejectedValueOnce(new Error('Database error'));
      
      await expect(manager.createRun('test.com', ['https://test.com/url1']))
        .rejects.toThrow('Database error');
    });

    it('should create runs for multiple domains', async () => {
      const config2 = createMockSiteConfig('example.com');
      manager.addSite('example.com', config2);
      
      const run1 = { 
        id: 'run-1', 
        domain: 'test.com',
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        items: []
      } as ScrapeRun;
      const run2 = { 
        id: 'run-2', 
        domain: 'example.com',
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        items: []
      } as ScrapeRun;
      
      mockCreateRun
        .mockResolvedValueOnce(run1)
        .mockResolvedValueOnce(run2);
      
      const result1 = await manager.createRun('test.com', [`https://test.com/url1`]);
      const result2 = await manager.createRun('example.com', [`https://example.com/url2`]);
      
      expect(result1.id).toBe('run-1');
      expect(result2.id).toBe('run-2');
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle getSite for non-existent domain', () => {
      const site = manager.getSite('nonexistent.com');
      expect(site).toBeUndefined();
    });

    it('should handle empty site list', () => {
      const sites = manager.getAllSites();
      expect(sites).toEqual([]);
      
      const configs = manager.getSiteConfigsWithBlockedProxies();
      expect(configs).resolves.toEqual([]);
    });

    it('should handle concurrent operations on same site', async () => {
      const config = createMockSiteConfig('test.com');
      manager.addSite('test.com', config);
      
      mockGetProxyById.mockImplementation((id: string) => 
        Promise.resolve({ id, type: 'datacenter', geo: 'US' })
      );
      
      // Start pagination and add blocked proxies concurrently
      const promises = [
        manager.startPagination('test.com', ['https://test.com/page1']),
        manager.addProxyToBlocklist('test.com', 'dc-proxy-1', 'Error 1'),
        manager.addProxyToBlocklist('test.com', 'dc-proxy-2', 'Error 2')
      ];
      
      await Promise.all(promises);
      
      expect(manager.hasPartialRun('test.com')).toBe(true);
      const blockedProxies = await manager.getBlockedProxies('test.com');
      expect(blockedProxies).toHaveLength(2);
    });

    it('should maintain site isolation', async () => {
      const config1 = createMockSiteConfig('site1.com');
      const config2 = createMockSiteConfig('site2.com');
      
      manager.addSite('site1.com', config1);
      manager.addSite('site2.com', config2);
      
      mockGetProxyById.mockResolvedValue({ 
        id: 'dc-proxy-1', 
        type: 'datacenter', 
        geo: 'US' 
      });
      
      // Add proxy to site1's blocklist
      await manager.addProxyToBlocklist('site1.com', 'dc-proxy-1', 'Error');
      
      // Verify site2 is not affected
      const site1Blocked = await manager.getBlockedProxies('site1.com');
      const site2Blocked = await manager.getBlockedProxies('site2.com');
      
      expect(site1Blocked).toContain('dc-proxy-1');
      expect(site2Blocked).toHaveLength(0);
      
      // Start pagination for site1
      await manager.startPagination('site1.com', ['https://site1.com/page']);
      
      // Verify site2 is not affected
      expect(manager.hasPartialRun('site1.com')).toBe(true);
      expect(manager.hasPartialRun('site2.com')).toBe(false);
    });
  });
});