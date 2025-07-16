import { describe, it, expect } from 'vitest';
import { itemsToSessions, type SessionInfo, type SiteConfigWithBlockedProxies } from '../src/core/distributor.js';
import type { ScrapeTarget } from '../src/types/scrape-target.js';

describe('distributor', () => {
  const createTarget = (url: string, done = false): ScrapeTarget => ({
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
      const targets = [createTarget('https://httpbin.org/1'), createTarget('https://httpbin.org/2')];
      const result = itemsToSessions(targets, []);
      expect(result).toEqual([]);
    });

    it('should return empty array for no pending targets', () => {
      const targets = [
        createTarget('https://httpbin.org/1', true),
        createTarget('https://httpbin.org/2', true)
      ];
      const result = itemsToSessions(targets, sessions);
      expect(result).toHaveLength(0);
    });

    it('should filter out completed targets and use sessions 1:1', () => {
      const targets = [
        createTarget('https://httpbin.org/1', false),
        createTarget('https://httpbin.org/2', true),
        createTarget('https://httpbin.org/3', false),
        createTarget('https://httpbin.org/4', true),
        createTarget('https://httpbin.org/5', false)
      ];
      const result = itemsToSessions(targets, sessions);
      expect(result).toHaveLength(3); // Only pending targets, each with unique session
      // Without site config, all sessions work, so it takes first available sessions
      expect(result[0]).toEqual({ url: 'https://httpbin.org/1', sessionId: 'session1' });
      expect(result[1]).toEqual({ url: 'https://httpbin.org/3', sessionId: 'session2' });
      expect(result[2]).toEqual({ url: 'https://httpbin.org/5', sessionId: 'session3' });
    });

    it('should match sessions based on site configurations with 1:1 mapping', () => {
      const targets = [
        createTarget('https://api.httpbin.org/1'),
        createTarget('https://api.httpbin.org/2'),
        createTarget('https://test.httpbin.org/1'),
        createTarget('https://test.httpbin.org/2')
      ];
      
      const siteConfigs: SiteConfigWithBlockedProxies[] = [
        {
          domain: 'api.httpbin.org',
          scraper: 'api.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'datacenter', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
        },
        {
          domain: 'test.httpbin.org',
          scraper: 'test.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'residential-stable', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
        }
      ];
      
      const result = itemsToSessions(targets, sessions, siteConfigs);
      expect(result).toHaveLength(2); // Only 2 pairs because we need specific session types
      
      // api.httpbin.org targets should use datacenter US (session1), but only one URL gets it
      expect(result[0]).toEqual({ url: 'https://api.httpbin.org/1', sessionId: 'session1' });
      
      // test.httpbin.org targets should use residential US (session2), but only one URL gets it
      expect(result[1]).toEqual({ url: 'https://test.httpbin.org/1', sessionId: 'session2' });
    });

    it('should respect blocked proxy IDs', () => {
      const targets = [
        createTarget('https://httpbin.org/1'),
        createTarget('https://httpbin.org/2')
      ];
      
      const siteConfigs: SiteConfigWithBlockedProxies[] = [
        {
          domain: 'httpbin.org',
          scraper: 'example.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'datacenter', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 },
          blockedProxyIds: ['proxy-dc-1'] // Block the first datacenter proxy
        }
      ];
      
      // Should skip session1 because its proxy is blocked
      // No other datacenter US proxy available, so no matches
      const result = itemsToSessions(targets, sessions, siteConfigs);
      expect(result).toHaveLength(0);
    });

    it('should match geo requirements with 1:1 mapping', () => {
      const targets = [
        createTarget('https://httpbin.org/uk/1'),
        createTarget('https://httpbin.org/uk/2')
      ];
      
      const siteConfigs: SiteConfigWithBlockedProxies[] = [
        {
          domain: 'httpbin.org',
          scraper: 'uk.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'datacenter', geo: 'UK', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
        }
      ];
      
      const result = itemsToSessions(targets, sessions, siteConfigs);
      expect(result).toHaveLength(1); // Only one datacenter UK session available
      
      // Should use session4 (datacenter UK) for first URL only
      expect(result[0]).toEqual({ url: 'https://httpbin.org/uk/1', sessionId: 'session4' });
    });

    it('should handle no proxy requirement with 1:1 mapping', () => {
      const targets = [
        createTarget('https://httpbin.org/no-proxy/1'),
        createTarget('https://httpbin.org/no-proxy/2')
      ];
      
      const siteConfigs: SiteConfigWithBlockedProxies[] = [
        {
          domain: 'httpbin.org',
          scraper: 'noproxy.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'none', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
        }
      ];
      
      const result = itemsToSessions(targets, sessions, siteConfigs);
      expect(result).toHaveLength(1); // Only one no-proxy session available
      
      // Should use session3 (no proxy) for first URL only
      expect(result[0]).toEqual({ url: 'https://httpbin.org/no-proxy/1', sessionId: 'session3' });
    });

    it('should handle datacenter-to-residential strategy', () => {
      const targets = [createTarget('https://httpbin.org/flexible/1')];
      
      const siteConfigs: SiteConfigWithBlockedProxies[] = [
        {
          domain: 'httpbin.org',
          scraper: 'flexible.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'datacenter-to-residential', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
        }
      ];
      
      const result = itemsToSessions(targets, sessions, siteConfigs);
      expect(result).toHaveLength(1);
      
      // Should use first matching session (datacenter US in this case)
      expect(result[0].sessionId).toBe('session1');
    });

    it('should handle no suitable sessions', () => {
      const targets = [createTarget('https://httpbin.org/impossible/1')];
      
      const siteConfigs: SiteConfigWithBlockedProxies[] = [
        {
          domain: 'httpbin.org',
          scraper: 'impossible.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'datacenter', geo: 'FR', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
        }
      ];
      
      const result = itemsToSessions(targets, sessions, siteConfigs);
      expect(result).toHaveLength(0); // No matching sessions for FR geo
    });

    it('should handle URLs without matching site config with 1:1 mapping', () => {
      const targets = [
        createTarget('https://httpbin.org/unknown/1'),
        createTarget('https://httpbin.org/unknown/2')
      ];
      
      const siteConfigs: SiteConfigWithBlockedProxies[] = [
        {
          domain: 'other.httpbin.org',
          scraper: 'other.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'datacenter', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
        }
      ];
      
      const result = itemsToSessions(targets, sessions, siteConfigs);
      expect(result).toHaveLength(2);
      
      // No site config found, so any session works (takes first available sessions)
      expect(result[0]).toEqual({ url: 'https://httpbin.org/unknown/1', sessionId: 'session1' });
      expect(result[1]).toEqual({ url: 'https://httpbin.org/unknown/2', sessionId: 'session2' });
    });

    it('should handle www prefixes correctly with 1:1 mapping', () => {
      const targets = [
        createTarget('https://www.httpbin.org/1'),
        createTarget('https://httpbin.org/2')
      ];
      
      const siteConfigs: SiteConfigWithBlockedProxies[] = [
        {
          domain: 'httpbin.org',
          scraper: 'example.ts',
          startPages: [],
          scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
          proxy: { strategy: 'residential-stable', geo: 'UK', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
        }
      ];
      
      const result = itemsToSessions(targets, sessions, siteConfigs);
      expect(result).toHaveLength(1); // Only one residential UK session available
      
      // First URL should match and use residential UK (session5)
      expect(result[0]).toEqual({ url: 'https://www.httpbin.org/1', sessionId: 'session5' });
    });

    it('should never reuse sessions', () => {
      const targets = [
        createTarget('https://httpbin.org/1'),
        createTarget('https://httpbin.org/2'),
        createTarget('https://httpbin.org/3'),
        createTarget('https://httpbin.org/4'),
        createTarget('https://httpbin.org/5'),
        createTarget('https://httpbin.org/6')
      ];
      
      const result = itemsToSessions(targets, sessions);
      expect(result).toHaveLength(5); // Max 5 because we only have 5 sessions
      
      // Verify all session IDs are unique
      const sessionIds = result.map(r => r.sessionId);
      const uniqueSessionIds = new Set(sessionIds);
      expect(uniqueSessionIds.size).toBe(sessionIds.length);
    });
  });
});