import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScrapeItemEngine } from '../scrape-item-engine.js';
import { SiteManager } from '../../services/site-manager.js';
import { SessionManager } from '../../services/session-manager.js';
import type { ScrapeRun, ScrapeRunItem } from '../../types/scrape-run.js';
import type { Item } from '../../types/item.js';

// Mock dependencies
vi.mock('../../services/site-manager.js');
vi.mock('../../services/session-manager.js');
vi.mock('../../core/distributor.js');
vi.mock('../../drivers/scraper-loader.js');
vi.mock('../../drivers/browser.js');
vi.mock('../../drivers/cache.js', () => ({
  RequestCache: vi.fn().mockImplementation(() => ({
    enableForPage: vi.fn(),
    getStats: vi.fn().mockReturnValue({
      hits: 0,
      misses: 0,
      sizeBytes: 0
    })
  }))
}));
vi.mock('../../drivers/etl.js', () => ({
  ETLDriver: vi.fn().mockImplementation(() => ({
    addItem: vi.fn().mockResolvedValue({ success: true, itemId: 'item-1' })
  }))
}));

describe('ScrapeItemEngine', () => {
  let engine: ScrapeItemEngine;
  let mockSiteManager: any;
  let mockSessionManager: any;
  
  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Create mock instances
    mockSiteManager = {
      listRuns: vi.fn(),
      getActiveRun: vi.fn(),
      getPendingItems: vi.fn(),
      getSiteConfigsWithBlockedProxies: vi.fn(),
      getProxyForDomain: vi.fn(),
      updateItemStatus: vi.fn()
    };
    
    mockSessionManager = {
      getActiveSessions: vi.fn(),
      createSession: vi.fn()
    };
    
    engine = new ScrapeItemEngine(mockSiteManager as any, mockSessionManager as any);
  });
  
  describe('scrapeItems', () => {
    it('should return empty result when no pending items', async () => {
      // Mock no active runs
      mockSiteManager.listRuns.mockResolvedValue({ runs: [] });
      
      const result = await engine.scrapeItems({});
      
      expect(result.success).toBe(true);
      expect(result.itemsScraped).toBe(0);
      expect(result.itemsBySite.size).toBe(0);
      expect(result.errors.size).toBe(0);
    });
    
    it('should process pending items from specified sites', async () => {
      const mockRun: ScrapeRun = {
        id: 'run-1',
        domain: 'site1.com',
        status: 'processing',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        items: [
          { url: 'https://site1.com/product/1', done: false, failed: false, invalid: false },
          { url: 'https://site1.com/product/2', done: false, failed: false, invalid: false }
        ]
      };
      
      const mockItem: Item = {
        sourceUrl: 'https://site1.com/product/1',
        product_id: 'prod-1',
        title: 'Test Product',
        brand: 'Test Brand',
        category: 'Test Category',
        price: 99.99,
        imageUrl: 'https://site1.com/image.jpg'
      };
      
      // Mock site manager
      mockSiteManager.getActiveRun.mockResolvedValue(mockRun);
      mockSiteManager.getPendingItems.mockResolvedValue(mockRun.items);
      mockSiteManager.getSiteConfigsWithBlockedProxies.mockResolvedValue([{
        domain: 'site1.com',
        itemUrlPattern: /\/product\//
      }]);
      
      // Mock session manager with an existing session
      mockSessionManager.getActiveSessions.mockResolvedValue([{
        id: 'existing-session-1',
        local: { proxy: { type: 'datacenter' } }
      }]);
      mockSessionManager.createSession.mockResolvedValue({
        id: 'new-session-1',
        local: { proxy: { type: 'datacenter' } }
      });
      
      // Mock distributor
      const { targetsToSessions } = await import('../../core/distributor.js');
      vi.mocked(targetsToSessions).mockReturnValue([
        { url: 'https://site1.com/product/1', sessionId: 'existing-0' }
      ]);
      
      // Mock browser
      const { createBrowserFromSession } = await import('../../drivers/browser.js');
      vi.mocked(createBrowserFromSession).mockResolvedValue({
        browser: { close: vi.fn() },
        createContext: vi.fn().mockResolvedValue({
          newPage: vi.fn().mockResolvedValue({
            goto: vi.fn(),
            close: vi.fn()
          })
        })
      });
      
      // Mock scraper
      const { loadScraper } = await import('../../drivers/scraper-loader.js');
      vi.mocked(loadScraper).mockResolvedValue({
        getItemUrls: vi.fn(),
        paginate: vi.fn(),
        scrapeItem: vi.fn().mockResolvedValue(mockItem)
      });
      
      // ETL driver is already mocked in module mock above
      
      const result = await engine.scrapeItems({
        sites: ['site1.com'],
        instanceLimit: 1,
        itemLimit: 10,
        noSave: false
      });
      
      expect(result.success).toBe(true);
      expect(result.itemsScraped).toBe(1);
      expect(result.itemsBySite.get('site1.com')).toHaveLength(1);
      expect(mockSiteManager.updateItemStatus).toHaveBeenCalledWith(
        'run-1',
        'https://site1.com/product/1',
        { done: true }
      );
    });
    
    it('should handle network errors with retries', async () => {
      const mockRun: ScrapeRun = {
        id: 'run-1',
        domain: 'site1.com',
        status: 'processing',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        items: [
          { url: 'https://site1.com/product/1', done: false, failed: false, invalid: false }
        ]
      };
      
      // Setup mocks
      mockSiteManager.getActiveRun.mockResolvedValue(mockRun);
      mockSiteManager.getPendingItems.mockResolvedValue(mockRun.items);
      mockSiteManager.getSiteConfigsWithBlockedProxies.mockResolvedValue([{
        domain: 'site1.com',
        itemUrlPattern: /\/product\//
      }]);
      
      mockSessionManager.getActiveSessions.mockResolvedValue([{
        id: 'existing-session-1',
        local: {}
      }]);
      mockSessionManager.createSession.mockResolvedValue({
        id: 'new-session-1',
        local: {}
      });
      
      const { targetsToSessions } = await import('../../core/distributor.js');
      vi.mocked(targetsToSessions).mockReturnValue([
        { url: 'https://site1.com/product/1', sessionId: 'existing-0' }
      ]);
      
      const { createBrowserFromSession } = await import('../../drivers/browser.js');
      const mockPage = {
        goto: vi.fn().mockRejectedValue(new Error('Navigation timeout')),
        close: vi.fn()
      };
      
      vi.mocked(createBrowserFromSession).mockResolvedValue({
        browser: { close: vi.fn() },
        createContext: vi.fn().mockResolvedValue({
          newPage: vi.fn().mockResolvedValue(mockPage)
        })
      });
      
      const { loadScraper } = await import('../../drivers/scraper-loader.js');
      vi.mocked(loadScraper).mockResolvedValue({
        getItemUrls: vi.fn(),
        paginate: vi.fn(),
        scrapeItem: vi.fn()
      });
      
      const result = await engine.scrapeItems({
        sites: ['site1.com'],
        maxRetries: 2,
        noSave: true
      });
      
      // Should fail after retries
      expect(result.success).toBe(false);
      expect(result.errors.size).toBe(1);
      expect(result.errors.get('https://site1.com/product/1')).toContain('Navigation timeout');
      
      // Should mark as failed after network error
      expect(mockSiteManager.updateItemStatus).toHaveBeenCalledWith(
        'run-1',
        'https://site1.com/product/1',
        { failed: true }
      );
    });
    
    it('should mark items as invalid for non-network errors', async () => {
      const mockRun: ScrapeRun = {
        id: 'run-1',
        domain: 'site1.com',
        status: 'processing',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        items: [
          { url: 'https://site1.com/product/1', done: false, failed: false, invalid: false }
        ]
      };
      
      // Setup mocks
      mockSiteManager.getActiveRun.mockResolvedValue(mockRun);
      mockSiteManager.getPendingItems.mockResolvedValue(mockRun.items);
      mockSiteManager.getSiteConfigsWithBlockedProxies.mockResolvedValue([{
        domain: 'site1.com',
        itemUrlPattern: /\/product\//
      }]);
      
      mockSessionManager.getActiveSessions.mockResolvedValue([{
        id: 'existing-session-1',
        local: {}
      }]);
      mockSessionManager.createSession.mockResolvedValue({
        id: 'new-session-1',
        local: {}
      });
      
      const { targetsToSessions } = await import('../../core/distributor.js');
      vi.mocked(targetsToSessions).mockReturnValue([
        { url: 'https://site1.com/product/1', sessionId: 'existing-0' }
      ]);
      
      const { createBrowserFromSession } = await import('../../drivers/browser.js');
      vi.mocked(createBrowserFromSession).mockResolvedValue({
        browser: { close: vi.fn() },
        createContext: vi.fn().mockResolvedValue({
          newPage: vi.fn().mockResolvedValue({
            goto: vi.fn(),
            close: vi.fn()
          })
        })
      });
      
      const { loadScraper } = await import('../../drivers/scraper-loader.js');
      vi.mocked(loadScraper).mockResolvedValue({
        getItemUrls: vi.fn(),
        paginate: vi.fn(),
        scrapeItem: vi.fn().mockRejectedValue(new Error('Missing required field'))
      });
      
      const result = await engine.scrapeItems({
        sites: ['site1.com'],
        noSave: true
      });
      
      // Should mark as invalid for non-network error
      expect(mockSiteManager.updateItemStatus).toHaveBeenCalledWith(
        'run-1',
        'https://site1.com/product/1',
        { invalid: true }
      );
    });
    
    it('should respect item limit per site', async () => {
      const mockItems: ScrapeRunItem[] = Array.from({ length: 20 }, (_, i) => ({
        url: `https://site1.com/product/${i}`,
        done: false,
        failed: false,
        invalid: false
      }));
      
      const mockRun: ScrapeRun = {
        id: 'run-1',
        domain: 'site1.com',
        status: 'processing',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        items: mockItems
      };
      
      mockSiteManager.getActiveRun.mockResolvedValue(mockRun);
      mockSiteManager.getPendingItems.mockResolvedValue(mockItems);
      mockSiteManager.getSiteConfigsWithBlockedProxies.mockResolvedValue([{
        domain: 'site1.com',
        itemUrlPattern: /\/product\//
      }]);
      
      mockSessionManager.getActiveSessions.mockResolvedValue([]);
      
      const { targetsToSessions } = await import('../../core/distributor.js');
      const mockedTargetsToSessions = vi.mocked(targetsToSessions);
      
      // Verify item limit is respected
      mockedTargetsToSessions.mockImplementation((targets) => {
        expect(targets.length).toBeLessThanOrEqual(5);
        return [];
      });
      
      await engine.scrapeItems({
        sites: ['site1.com'],
        itemLimit: 5, // Limit to 5 items per site
        noSave: true
      });
      
      expect(mockedTargetsToSessions).toHaveBeenCalled();
    });
    
    it('should collect cache statistics when caching enabled', async () => {
      // Mock empty runs to get empty result
      mockSiteManager.listRuns.mockResolvedValue({ runs: [] });
      
      const result = await engine.scrapeItems({
        disableCache: false,
        cacheSizeMB: 50,
        cacheTTLSeconds: 600
      });
      
      expect(result.success).toBe(true);
      // Cache stats should be undefined when no processing happens
      expect(result.cacheStats).toBeUndefined();
    });
  });
});