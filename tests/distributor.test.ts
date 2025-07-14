import { describe, it, expect } from 'vitest';
import { itemsToSessions, type SessionInfo } from '../src/lib/distributor.js';
import type { ScrapeRunItem } from '../src/types/scrape-run.js';
import type { SiteConfig } from '../src/types/site-config-types.js';

describe('distributor', () => {
  const createItem = (url: string, done = false): ScrapeRunItem => ({
    url,
    done,
    failed: false,
    invalid: false
  });

  const sessions: SessionInfo[] = [
    { id: 'session1', proxyType: 'datacenter' },
    { id: 'session2', proxyType: 'residential' },
    { id: 'session3', proxyType: 'none' }
  ];

  describe('itemsToSessions', () => {
    it('should return empty array for no sessions', () => {
      const items = [createItem('url1'), createItem('url2')];
      const result = itemsToSessions(items, []);
      expect(result).toEqual([]);
    });

    it('should return empty array for no pending items', () => {
      const items = [
        createItem('url1', true),
        createItem('url2', true)
      ];
      const result = itemsToSessions(items, sessions);
      expect(result).toHaveLength(0);
    });

    it('should filter out completed items', () => {
      const items = [
        createItem('url1', false),
        createItem('url2', true),
        createItem('url3', false),
        createItem('url4', true),
        createItem('url5', false)
      ];
      const result = itemsToSessions(items, sessions);
      expect(result).toHaveLength(3); // Only pending items
      // Without site config, all sessions work, so it takes first session for each
      expect(result[0]).toEqual({ url: 'url1', sessionId: 'session1' });
      expect(result[1]).toEqual({ url: 'url3', sessionId: 'session1' });
      expect(result[2]).toEqual({ url: 'url5', sessionId: 'session1' });
    });

    it('should match sessions based on proxy requirements', () => {
      const items = Array.from({ length: 3 }, (_, i) => createItem(`url${i}`));
      
      // Test datacenter requirement
      const datacenterConfig: SiteConfig = {
        domain: 'test.com',
        scraper: 'test.ts',
        startPages: [],
        scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
        proxy: { strategy: 'datacenter', geo: 'US', cooldownMinutes: 30, failureThreshold: 2 }
      };
      
      const result = itemsToSessions(items, sessions, datacenterConfig);
      expect(result).toHaveLength(3);
      // All should use session1 (datacenter)
      result.forEach(pair => {
        expect(pair.sessionId).toBe('session1');
      });
    });

    it('should match residential proxy requirement', () => {
      const items = Array.from({ length: 2 }, (_, i) => createItem(`url${i}`));
      
      const residentialConfig: SiteConfig = {
        domain: 'test.com',
        scraper: 'test.ts',
        startPages: [],
        scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
        proxy: { strategy: 'residential-stable', geo: 'US', cooldownMinutes: 30, failureThreshold: 2 }
      };
      
      const result = itemsToSessions(items, sessions, residentialConfig);
      expect(result).toHaveLength(2);
      // All should use session2 (residential)
      result.forEach(pair => {
        expect(pair.sessionId).toBe('session2');
      });
    });

    it('should handle no proxy requirement', () => {
      const items = Array.from({ length: 2 }, (_, i) => createItem(`url${i}`));
      
      const noProxyConfig: SiteConfig = {
        domain: 'test.com',
        scraper: 'test.ts',
        startPages: [],
        scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
        proxy: { strategy: 'none', geo: 'US', cooldownMinutes: 30, failureThreshold: 2 }
      };
      
      const result = itemsToSessions(items, sessions, noProxyConfig);
      expect(result).toHaveLength(2);
      // All should use session3 (no proxy)
      result.forEach(pair => {
        expect(pair.sessionId).toBe('session3');
      });
    });

    it('should handle no suitable sessions', () => {
      const items = [createItem('url1')];
      const residentialOnlySessions: SessionInfo[] = [
        { id: 'session1', proxyType: 'residential' }
      ];
      
      const datacenterConfig: SiteConfig = {
        domain: 'test.com',
        scraper: 'test.ts',
        startPages: [],
        scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
        proxy: { strategy: 'datacenter', geo: 'US', cooldownMinutes: 30, failureThreshold: 2 }
      };
      
      const result = itemsToSessions(items, residentialOnlySessions, datacenterConfig);
      expect(result).toHaveLength(0); // No matching sessions
    });
  });
});