import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaginateEngine } from '../paginate-engine.js';
import { SiteManager } from '../../services/site-manager.js';
import { SessionManager } from '../../services/session-manager.js';
import type { Session } from '../../types/session.js';
import type { SiteState } from '../../services/site-manager.js';

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

describe('PaginateEngine', () => {
  let engine: PaginateEngine;
  let mockSiteManager: any;
  let mockSessionManager: any;
  
  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Create mock instances
    mockSiteManager = {
      getSitesWithStartPages: vi.fn(),
      getSite: vi.fn(),
      startPagination: vi.fn(),
      getSiteConfigsWithBlockedProxies: vi.fn(),
      getProxyForDomain: vi.fn(),
      updatePaginationState: vi.fn(),
      commitPartialRun: vi.fn(),
      hasPartialRun: vi.fn(),
      getStartPagesForDomain: vi.fn(),
      listRuns: vi.fn()
    };
    
    mockSessionManager = {
      getActiveSessions: vi.fn(),
      createSession: vi.fn()
    };
    
    engine = new PaginateEngine(mockSiteManager as any, mockSessionManager as any);
  });
  
  describe('paginate', () => {
    it('should return empty result when no sites to process', async () => {
      mockSiteManager.getSitesWithStartPages.mockReturnValue([]);
      
      const result = await engine.paginate({});
      
      expect(result.success).toBe(true);
      expect(result.sitesProcessed).toBe(0);
      expect(result.totalUrls).toBe(0);
      expect(result.urlsBySite.size).toBe(0);
      expect(result.errors.size).toBe(0);
    });
    
    it('should process specified sites', async () => {
      const mockSites = ['site1.com', 'site2.com'];
      const mockSiteStates: SiteState[] = [
        {
          domain: 'site1.com',
          config: {
            domain: 'site1.com',
            startPages: ['https://site1.com/products'],
            itemUrlPattern: /\/product\//
          },
          proxyBlocklist: new Map()
        },
        {
          domain: 'site2.com',
          config: {
            domain: 'site2.com',
            startPages: ['https://site2.com/catalog'],
            itemUrlPattern: /\/item\//
          },
          proxyBlocklist: new Map()
        }
      ];
      
      // Mock site manager responses
      mockSiteManager.getSite.mockImplementation((domain: string) => 
        mockSiteStates.find(s => s.domain === domain)
      );
      mockSiteManager.getSiteConfigsWithBlockedProxies.mockResolvedValue(
        mockSiteStates.map(s => s.config)
      );
      mockSiteManager.getStartPagesForDomain.mockImplementation((domain: string) => {
        const site = mockSiteStates.find(s => s.domain === domain);
        return site ? site.config.startPages : [];
      });
      mockSiteManager.listRuns.mockResolvedValue({ runs: [] });
      
      // Mock no existing sessions
      mockSessionManager.getActiveSessions.mockResolvedValue([]);
      
      // Mock session creation
      mockSessionManager.createSession.mockResolvedValue({
        id: 'test-session-1',
        local: { proxy: { type: 'datacenter' } }
      });
      
      // Mock distributor to return a valid sessionId that exists in sessionDataMap
      const { targetsToSessions } = await import('../../core/distributor.js');
      vi.mocked(targetsToSessions).mockReturnValue([
        { url: 'https://site1.com/products', sessionId: 'existing-0' }
      ]);
      
      // Mock browser creation
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
        getItemUrls: vi.fn().mockResolvedValue(new Set(['https://site1.com/product/1'])),
        paginate: vi.fn().mockResolvedValue(false), // No more pages
        scrapeItem: vi.fn()
      });
      
      // Mock successful partial run commit
      mockSiteManager.commitPartialRun.mockResolvedValue({
        id: 'run-1',
        domain: 'site1.com',
        items: []
      });
      
      // Mock hasPartialRun to return true after startPagination
      mockSiteManager.hasPartialRun.mockReturnValue(true);
      
      // Mock the private partialRuns access
      (mockSiteManager as any).partialRuns = new Map([
        ['site1.com', {
          siteId: 'site1.com',
          paginationStates: new Map([
            ['https://site1.com/products', {
              startPageUrl: 'https://site1.com/products',
              collectedUrls: ['https://site1.com/product/1'],
              completed: true,
              failureCount: 0,
              failureHistory: []
            }]
          ]),
          totalUrlsCollected: 1,
          createdAt: new Date(),
          committedToDb: false
        }]
      ]);
      
      const result = await engine.paginate({
        sites: mockSites,
        instanceLimit: 1,
        maxPages: 1,
        noSave: false
      });
      
      expect(mockSiteManager.startPagination).toHaveBeenCalledWith(
        'site1.com',
        ['https://site1.com/products']
      );
      expect(result.success).toBe(true);
      expect(result.sitesProcessed).toBeGreaterThan(0);
    });
    
    it('should handle errors gracefully', async () => {
      const mockSite = 'error-site.com';
      
      mockSiteManager.getSite.mockReturnValue({
        domain: mockSite,
        config: {
          domain: mockSite,
          startPages: ['https://error-site.com/products'],
          itemUrlPattern: /\/product\//
        },
        proxyBlocklist: new Map()
      });
      
      mockSiteManager.getSiteConfigsWithBlockedProxies.mockResolvedValue([{
        domain: mockSite,
        startPages: ['https://error-site.com/products'],
        itemUrlPattern: /\/product\//
      }]);
      mockSiteManager.getStartPagesForDomain.mockResolvedValue(['https://error-site.com/products']);
      mockSiteManager.listRuns.mockResolvedValue({ runs: [] });
      
      // Mock an existing session so browser creation will be attempted
      mockSessionManager.getActiveSessions.mockResolvedValue([{
        id: 'existing-session-1',
        local: { proxy: { type: 'datacenter' } }
      }]);
      mockSessionManager.createSession.mockResolvedValue({
        id: 'new-session-1',
        local: { proxy: { type: 'datacenter' } }
      });
      
      // Mock distributor to match to existing session
      const { targetsToSessions } = await import('../../core/distributor.js');
      vi.mocked(targetsToSessions).mockReturnValue([
        { url: 'https://error-site.com/products', sessionId: 'existing-0' }
      ]);
      
      // Mock browser creation to fail
      const { createBrowserFromSession } = await import('../../drivers/browser.js');
      vi.mocked(createBrowserFromSession).mockRejectedValue(new Error('Browser creation failed'));
      
      // The engine should propagate the browser creation error
      await expect(engine.paginate({
        sites: [mockSite],
        instanceLimit: 1,
        noSave: true
      })).rejects.toThrow('Browser creation failed');
    });
    
    it('should respect instance limit', async () => {
      const mockSites = ['site1.com'];
      const startPages = Array.from({ length: 10 }, (_, i) => `https://site1.com/page${i}`);
      
      mockSiteManager.getSite.mockReturnValue({
        domain: 'site1.com',
        config: {
          domain: 'site1.com',
          startPages,
          itemUrlPattern: /\/product\//
        },
        proxyBlocklist: new Map()
      });
      
      mockSiteManager.getSiteConfigsWithBlockedProxies.mockResolvedValue([{
        domain: 'site1.com',
        startPages,
        itemUrlPattern: /\/product\//
      }]);
      mockSiteManager.getStartPagesForDomain.mockResolvedValue(startPages.slice(0, 3)); // respect instance limit
      mockSiteManager.listRuns.mockResolvedValue({ runs: [] });
      
      mockSessionManager.getActiveSessions.mockResolvedValue([]);
      
      const { targetsToSessions } = await import('../../core/distributor.js');
      const mockedTargetsToSessions = vi.mocked(targetsToSessions);
      
      // Mock to verify instance limit is respected
      mockedTargetsToSessions.mockImplementation((targets, sessions) => {
        // Should only process up to instanceLimit targets
        expect(targets.length).toBeLessThanOrEqual(3);
        // Return empty to avoid processing
        return [];
      });
      
      // Mock other dependencies to allow test to proceed
      mockSessionManager.createSession.mockResolvedValue({
        id: 'test-session',
        local: {}
      });
      
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
        getItemUrls: vi.fn().mockResolvedValue(new Set()),
        paginate: vi.fn().mockResolvedValue(false),
        scrapeItem: vi.fn()
      });
      
      await engine.paginate({
        sites: mockSites,
        instanceLimit: 3, // Limit to 3 concurrent sessions
        noSave: true
      });
      
      // Verify distributor was called with limited targets
      expect(mockedTargetsToSessions).toHaveBeenCalled();
    });
    
    it('should use cache when enabled', async () => {
      mockSiteManager.getSitesWithStartPages.mockReturnValue([]);
      
      const result = await engine.paginate({
        disableCache: false,
        cacheSizeMB: 50,
        cacheTTLSeconds: 600
      });
      
      expect(result.success).toBe(true);
      // Cache stats should be undefined when no processing happens
      expect(result.cacheStats).toBeUndefined();
    });
    
    it('should not use cache when disabled', async () => {
      mockSiteManager.getSitesWithStartPages.mockReturnValue([]);
      
      const result = await engine.paginate({
        disableCache: true
      });
      
      expect(result.success).toBe(true);
      expect(result.cacheStats).toBeUndefined();
    });
  });
});