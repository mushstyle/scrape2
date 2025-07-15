import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SiteManager } from '../src/lib/site-manager.js';
import type { SiteConfig } from '../src/types/site-config-types.js';

// Mock the providers
vi.mock('../src/providers/etl-api.js', () => ({
  getSites: vi.fn()
}));

vi.mock('../src/providers/site-config.js', () => ({
  getSiteConfig: vi.fn()
}));

import { getSites } from '../src/providers/etl-api.js';
import { getSiteConfig } from '../src/providers/site-config.js';

const mockGetSites = getSites as any;
const mockGetSiteConfig = getSiteConfig as any;

describe('SiteManager', () => {
  let siteManager: SiteManager;

  const mockSiteConfig1: SiteConfig = {
    domain: 'example.com',
    scraper: 'example.ts',
    startPages: ['https://example.com/page1', 'https://example.com/page2'],
    scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
    proxy: { strategy: 'datacenter', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 2 }
  };

  const mockSiteConfig2: SiteConfig = {
    domain: 'test.com',
    scraper: 'test.ts',
    startPages: ['https://test.com/start'],
    scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
    proxy: { strategy: 'residential-stable', geo: 'UK', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 1 }
  };

  const mockSiteConfig3: SiteConfig = {
    domain: 'nostart.com',
    scraper: 'nostart.ts',
    startPages: [],
    scraping: { browser: { ignoreHttpsErrors: false, headers: {} } }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    siteManager = new SiteManager();
  });

  describe('loadSites', () => {
    it('should load sites from ETL API', async () => {
      mockGetSites.mockResolvedValue({
        data: [
          { _id: 'example.com' },
          { domain: 'test.com' },
          { id: 'nostart.com' }
        ]
      });

      mockGetSiteConfig.mockImplementation((domain: string) => {
        switch (domain) {
          case 'example.com':
            return Promise.resolve(mockSiteConfig1);
          case 'test.com':
            return Promise.resolve(mockSiteConfig2);
          case 'nostart.com':
            return Promise.resolve(mockSiteConfig3);
          default:
            return Promise.reject(new Error('Not found'));
        }
      });

      await siteManager.loadSites();

      expect(mockGetSites).toHaveBeenCalledTimes(1);
      expect(mockGetSiteConfig).toHaveBeenCalledTimes(3);
      expect(siteManager.size()).toBe(3);
      expect(siteManager.isLoaded()).toBe(true);
    });

    it('should handle sites with missing domain', async () => {
      mockGetSites.mockResolvedValue({
        sites: [
          { _id: 'example.com' },
          { /* missing domain */ },
          { domain: 'test.com' }
        ]
      });

      mockGetSiteConfig.mockImplementation((domain: string) => {
        switch (domain) {
          case 'example.com':
            return Promise.resolve(mockSiteConfig1);
          case 'test.com':
            return Promise.resolve(mockSiteConfig2);
          default:
            return Promise.reject(new Error('Not found'));
        }
      });

      await siteManager.loadSites();

      expect(siteManager.size()).toBe(2);
    });

    it('should handle failed config loads', async () => {
      mockGetSites.mockResolvedValue({
        data: [
          { domain: 'example.com' },
          { domain: 'test.com' },
          { domain: 'error.com' }
        ]
      });

      mockGetSiteConfig.mockImplementation((domain: string) => {
        if (domain === 'error.com') {
          return Promise.reject(new Error('Config load failed'));
        }
        return Promise.resolve(mockSiteConfig1);
      });

      await siteManager.loadSites();

      expect(siteManager.size()).toBe(2);
      expect(siteManager.getSite('error.com')).toBeUndefined();
    });
  });

  describe('site access methods', () => {
    beforeEach(async () => {
      // Manually add sites for testing
      siteManager.addSite('example.com', mockSiteConfig1);
      siteManager.addSite('test.com', mockSiteConfig2);
      siteManager.addSite('nostart.com', mockSiteConfig3);
    });

    it('should get all sites', () => {
      const sites = siteManager.getAllSites();
      expect(sites).toHaveLength(3);
      expect(sites.map(s => s.domain).sort()).toEqual(['example.com', 'nostart.com', 'test.com']);
    });

    it('should get sites with start pages', () => {
      const sites = siteManager.getSitesWithStartPages();
      expect(sites).toHaveLength(2);
      expect(sites.map(s => s.domain).sort()).toEqual(['example.com', 'test.com']);
    });

    it('should get specific site by domain', () => {
      const site = siteManager.getSite('example.com');
      expect(site).toBeDefined();
      expect(site?.domain).toBe('example.com');
      expect(site?.config.scraper).toBe('example.ts');
    });

    it('should handle www prefix when getting site', () => {
      const site = siteManager.getSite('www.example.com');
      expect(site).toBeDefined();
      expect(site?.domain).toBe('example.com');
    });

    it('should return undefined for non-existent site', () => {
      const site = siteManager.getSite('nonexistent.com');
      expect(site).toBeUndefined();
    });
  });

  describe('site state updates', () => {
    beforeEach(() => {
      siteManager.addSite('example.com', mockSiteConfig1);
    });

    it('should update site state', () => {
      const now = new Date();
      siteManager.updateSite('example.com', {
        lastScraped: now,
        activeSessionCount: 3
      });

      const site = siteManager.getSite('example.com');
      expect(site?.lastScraped).toEqual(now);
      expect(site?.activeSessionCount).toBe(3);
      expect(site?.config.scraper).toBe('example.ts'); // Config preserved
    });

    it('should handle www prefix when updating', () => {
      siteManager.updateSite('www.example.com', {
        activeSessionCount: 5
      });

      const site = siteManager.getSite('example.com');
      expect(site?.activeSessionCount).toBe(5);
    });

    it('should not update non-existent site', () => {
      siteManager.updateSite('nonexistent.com', {
        activeSessionCount: 10
      });

      expect(siteManager.getSite('nonexistent.com')).toBeUndefined();
    });
  });

  describe('custom data management', () => {
    beforeEach(() => {
      siteManager.addSite('example.com', mockSiteConfig1);
    });

    it('should update and get custom data', () => {
      siteManager.updateSiteCustomData('example.com', 'lastError', 'Connection timeout');
      siteManager.updateSiteCustomData('example.com', 'retryCount', 3);

      expect(siteManager.getSiteCustomData('example.com', 'lastError')).toBe('Connection timeout');
      expect(siteManager.getSiteCustomData('example.com', 'retryCount')).toBe(3);
    });

    it('should handle custom data for non-existent site', () => {
      siteManager.updateSiteCustomData('nonexistent.com', 'key', 'value');
      expect(siteManager.getSiteCustomData('nonexistent.com', 'key')).toBeUndefined();
    });
  });

  describe('start pages management', () => {
    beforeEach(() => {
      siteManager.addSite('example.com', mockSiteConfig1);
      siteManager.addSite('test.com', mockSiteConfig2);
      siteManager.addSite('nostart.com', mockSiteConfig3);
    });

    it('should get start pages for domain respecting sessionLimit', () => {
      const pages = siteManager.getStartPagesForDomain('example.com');
      expect(pages).toHaveLength(2); // sessionLimit is 2
      expect(pages).toEqual(['https://example.com/page1', 'https://example.com/page2']);
    });

    it('should get start pages when sessionLimit exceeds available pages', () => {
      const pages = siteManager.getStartPagesForDomain('test.com');
      expect(pages).toHaveLength(1); // Only 1 start page available
      expect(pages).toEqual(['https://test.com/start']);
    });

    it('should return empty array for sites without start pages', () => {
      const pages = siteManager.getStartPagesForDomain('nostart.com');
      expect(pages).toHaveLength(0);
    });

    it('should get all start pages from all sites', () => {
      const allPages = siteManager.getAllStartPages();
      expect(allPages).toHaveLength(3); // 2 from example.com + 1 from test.com
      expect(allPages).toContainEqual({ url: 'https://example.com/page1', domain: 'example.com' });
      expect(allPages).toContainEqual({ url: 'https://example.com/page2', domain: 'example.com' });
      expect(allPages).toContainEqual({ url: 'https://test.com/start', domain: 'test.com' });
    });
  });

  describe('site management', () => {
    it('should add new site', () => {
      siteManager.addSite('new.com', mockSiteConfig1, {
        lastScraped: new Date(),
        activeSessionCount: 2
      });

      const site = siteManager.getSite('new.com');
      expect(site).toBeDefined();
      expect(site?.activeSessionCount).toBe(2);
    });

    it('should remove site', () => {
      siteManager.addSite('example.com', mockSiteConfig1);
      
      const removed = siteManager.removeSite('example.com');
      expect(removed).toBe(true);
      expect(siteManager.getSite('example.com')).toBeUndefined();
      expect(siteManager.size()).toBe(0);
    });

    it('should return false when removing non-existent site', () => {
      const removed = siteManager.removeSite('nonexistent.com');
      expect(removed).toBe(false);
    });

    it('should clear all sites', () => {
      siteManager.addSite('example.com', mockSiteConfig1);
      siteManager.addSite('test.com', mockSiteConfig2);

      siteManager.clear();
      expect(siteManager.size()).toBe(0);
      expect(siteManager.isLoaded()).toBe(false);
    });
  });

  describe('getSiteConfigs', () => {
    it('should return all site configurations', () => {
      siteManager.addSite('example.com', mockSiteConfig1);
      siteManager.addSite('test.com', mockSiteConfig2);

      const configs = siteManager.getSiteConfigs();
      expect(configs).toHaveLength(2);
      expect(configs).toContainEqual(mockSiteConfig1);
      expect(configs).toContainEqual(mockSiteConfig2);
    });
  });
});