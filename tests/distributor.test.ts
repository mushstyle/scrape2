import { describe, it, expect } from 'vitest';
import { itemsToSessions, type SessionInfo, type SiteConfigWithBlockedProxies } from '../src/lib/distributor.js';
import type { ScrapeRunItem } from '../src/types/scrape-run.js';

describe('distributor', () => {
  const createItem = (url: string, done = false): ScrapeRunItem => ({
    url,
    done,
    failed: false,
    invalid: false
  });

  const sessions: SessionInfo[] = [
    { id: 'session1', proxyType: 'datacenter', proxyId: 'proxy-dc-1', proxyGeo: 'US' },
    { id: 'session2', proxyType: 'residential', proxyId: 'proxy-res-1', proxyGeo: 'US' },
    { id: 'session3', proxyType: 'none' },
    { id: 'session4', proxyType: 'datacenter', proxyId: 'proxy-dc-2', proxyGeo: 'UK' },
    { id: 'session5', proxyType: 'residential', proxyId: 'proxy-res-2', proxyGeo: 'UK' }
  ];

  describe('itemsToSessions', () => {
    it('should return empty array for no sessions', () => {
      const items = [createItem('https://example.com/1'), createItem('https://example.com/2')];
      const result = itemsToSessions(items, []);
      expect(result).toEqual([]);
    });

    it('should return empty array for no pending items', () => {
      const items = [
        createItem('https://example.com/1', true),
        createItem('https://example.com/2', true)
      ];
      const result = itemsToSessions(items, sessions);
      expect(result).toHaveLength(0);
    });

    it('should filter out completed items', () => {
      const items = [
        createItem('https://example.com/1', false),
        createItem('https://example.com/2', true),
        createItem('https://example.com/3', false),
        createItem('https://example.com/4', true),
        createItem('https://example.com/5', false)
      ];
      const result = itemsToSessions(items, sessions);
      expect(result).toHaveLength(3); // Only pending items
      // Without site config, all sessions work, so it takes first session for each
      expect(result[0]).toEqual({ url: 'https://example.com/1', sessionId: 'session1' });
      expect(result[1]).toEqual({ url: 'https://example.com/3', sessionId: 'session1' });
      expect(result[2]).toEqual({ url: 'https://example.com/5', sessionId: 'session1' });
    });

    it('should match sessions based on site configurations', () => {
      const items = [
        createItem('https://example.com/1'),
        createItem('https://example.com/2'),
        createItem('https://test.com/1'),
        createItem('https://test.com/2')
      ];
      
      const siteConfigs: SiteConfigWithBlockedProxies[] = [
        {
          domain: 'example.com',
          scraper: 'example.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'datacenter', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
        },
        {
          domain: 'test.com',
          scraper: 'test.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'residential-stable', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
        }
      ];
      
      const result = itemsToSessions(items, sessions, siteConfigs);
      expect(result).toHaveLength(4);
      
      // example.com items should use datacenter US (session1)
      expect(result[0]).toEqual({ url: 'https://example.com/1', sessionId: 'session1' });
      expect(result[1]).toEqual({ url: 'https://example.com/2', sessionId: 'session1' });
      
      // test.com items should use residential US (session2)
      expect(result[2]).toEqual({ url: 'https://test.com/1', sessionId: 'session2' });
      expect(result[3]).toEqual({ url: 'https://test.com/2', sessionId: 'session2' });
    });

    it('should respect blocked proxy IDs', () => {
      const items = [
        createItem('https://example.com/1'),
        createItem('https://example.com/2')
      ];
      
      const siteConfigs: SiteConfigWithBlockedProxies[] = [
        {
          domain: 'example.com',
          scraper: 'example.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'datacenter', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 },
          blockedProxyIds: ['proxy-dc-1'] // Block the first datacenter proxy
        }
      ];
      
      // Should skip session1 because its proxy is blocked
      // No other datacenter US proxy available, so no matches
      const result = itemsToSessions(items, sessions, siteConfigs);
      expect(result).toHaveLength(0);
    });

    it('should match geo requirements', () => {
      const items = [
        createItem('https://uk-site.com/1'),
        createItem('https://uk-site.com/2')
      ];
      
      const siteConfigs: SiteConfigWithBlockedProxies[] = [
        {
          domain: 'uk-site.com',
          scraper: 'uk.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'datacenter', geo: 'UK', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
        }
      ];
      
      const result = itemsToSessions(items, sessions, siteConfigs);
      expect(result).toHaveLength(2);
      
      // Should use session4 (datacenter UK)
      expect(result[0]).toEqual({ url: 'https://uk-site.com/1', sessionId: 'session4' });
      expect(result[1]).toEqual({ url: 'https://uk-site.com/2', sessionId: 'session4' });
    });

    it('should handle no proxy requirement', () => {
      const items = [
        createItem('https://no-proxy.com/1'),
        createItem('https://no-proxy.com/2')
      ];
      
      const siteConfigs: SiteConfigWithBlockedProxies[] = [
        {
          domain: 'no-proxy.com',
          scraper: 'noproxy.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'none', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
        }
      ];
      
      const result = itemsToSessions(items, sessions, siteConfigs);
      expect(result).toHaveLength(2);
      
      // Should use session3 (no proxy)
      expect(result[0]).toEqual({ url: 'https://no-proxy.com/1', sessionId: 'session3' });
      expect(result[1]).toEqual({ url: 'https://no-proxy.com/2', sessionId: 'session3' });
    });

    it('should handle datacenter-to-residential strategy', () => {
      const items = [createItem('https://flexible.com/1')];
      
      const siteConfigs: SiteConfigWithBlockedProxies[] = [
        {
          domain: 'flexible.com',
          scraper: 'flexible.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'datacenter-to-residential', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
        }
      ];
      
      const result = itemsToSessions(items, sessions, siteConfigs);
      expect(result).toHaveLength(1);
      
      // Should use first matching session (datacenter US in this case)
      expect(result[0].sessionId).toBe('session1');
    });

    it('should handle no suitable sessions', () => {
      const items = [createItem('https://impossible.com/1')];
      
      const siteConfigs: SiteConfigWithBlockedProxies[] = [
        {
          domain: 'impossible.com',
          scraper: 'impossible.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'datacenter', geo: 'FR', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
        }
      ];
      
      const result = itemsToSessions(items, sessions, siteConfigs);
      expect(result).toHaveLength(0); // No matching sessions for FR geo
    });

    it('should handle URLs without matching site config', () => {
      const items = [
        createItem('https://unknown-site.com/1'),
        createItem('https://unknown-site.com/2')
      ];
      
      const siteConfigs: SiteConfigWithBlockedProxies[] = [
        {
          domain: 'other-site.com',
          scraper: 'other.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'datacenter', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
        }
      ];
      
      const result = itemsToSessions(items, sessions, siteConfigs);
      expect(result).toHaveLength(2);
      
      // No site config found, so any session works (takes first)
      expect(result[0]).toEqual({ url: 'https://unknown-site.com/1', sessionId: 'session1' });
      expect(result[1]).toEqual({ url: 'https://unknown-site.com/2', sessionId: 'session1' });
    });

    it('should handle www prefixes correctly', () => {
      const items = [
        createItem('https://www.example.com/1'),
        createItem('https://example.com/2')
      ];
      
      const siteConfigs: SiteConfigWithBlockedProxies[] = [
        {
          domain: 'example.com',
          scraper: 'example.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'residential-stable', geo: 'UK', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
        }
      ];
      
      const result = itemsToSessions(items, sessions, siteConfigs);
      expect(result).toHaveLength(2);
      
      // Both should match and use residential UK (session5)
      expect(result[0]).toEqual({ url: 'https://www.example.com/1', sessionId: 'session5' });
      expect(result[1]).toEqual({ url: 'https://example.com/2', sessionId: 'session5' });
    });
  });
});