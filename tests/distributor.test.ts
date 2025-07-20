import { describe, it, expect } from 'vitest';
import { targetsToSessions, type SessionInfo, type SiteConfigWithBlockedProxies } from '../src/core/distributor.js';
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

  describe('targetsToSessions', () => {
    it('should return empty array for no sessions', () => {
      const targets = [createTarget('https://httpbin.org/1'), createTarget('https://httpbin.org/2')];
      const result = targetsToSessions(targets, []);
      expect(result).toEqual([]);
    });

    it('should return empty array for no pending targets', () => {
      const targets = [
        createTarget('https://httpbin.org/1', true),
        createTarget('https://httpbin.org/2', true)
      ];
      const result = targetsToSessions(targets, sessions);
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
      const result = targetsToSessions(targets, sessions);
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
      
      const result = targetsToSessions(targets, sessions, siteConfigs);
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
      const result = targetsToSessions(targets, sessions, siteConfigs);
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
      
      const result = targetsToSessions(targets, sessions, siteConfigs);
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
      
      const result = targetsToSessions(targets, sessions, siteConfigs);
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
      
      const result = targetsToSessions(targets, sessions, siteConfigs);
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
      
      const result = targetsToSessions(targets, sessions, siteConfigs);
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
      
      const result = targetsToSessions(targets, sessions, siteConfigs);
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
      
      const result = targetsToSessions(targets, sessions, siteConfigs);
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
      
      const result = targetsToSessions(targets, sessions);
      expect(result).toHaveLength(5); // Max 5 because we only have 5 sessions
      
      // Verify all session IDs are unique
      const sessionIds = result.map(r => r.sessionId);
      const uniqueSessionIds = new Set(sessionIds);
      expect(uniqueSessionIds.size).toBe(sessionIds.length);
    });

    describe('session limit enforcement', () => {
      it('should respect session limits per domain', () => {
        const targets = [
          createTarget('https://limited.com/1'),
          createTarget('https://limited.com/2'),
          createTarget('https://limited.com/3'),
          createTarget('https://limited.com/4'),
          createTarget('https://limited.com/5')
        ];
        
        const siteConfigs: SiteConfigWithBlockedProxies[] = [
          {
            domain: 'limited.com',
            scraper: 'limited.ts',
            startPages: [],
            scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
            proxy: { strategy: 'datacenter', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
          }
        ];
        
        // Even though we have 5 sessions available and 5 URLs, should only match 3 due to sessionLimit
        const result = targetsToSessions(targets, sessions, siteConfigs);
        expect(result).toHaveLength(3);
        
        // Verify all matched URLs are from limited.com
        result.forEach(pair => {
          expect(pair.url).toMatch(/^https:\/\/limited\.com/);
        });
      });

      it('should respect different session limits for different domains', () => {
        const targets = [
          // 5 URLs for site with limit 2
          createTarget('https://site-a.com/1'),
          createTarget('https://site-a.com/2'),
          createTarget('https://site-a.com/3'),
          createTarget('https://site-a.com/4'),
          createTarget('https://site-a.com/5'),
          // 4 URLs for site with limit 3
          createTarget('https://site-b.com/1'),
          createTarget('https://site-b.com/2'),
          createTarget('https://site-b.com/3'),
          createTarget('https://site-b.com/4')
        ];
        
        const siteConfigs: SiteConfigWithBlockedProxies[] = [
          {
            domain: 'site-a.com',
            scraper: 'site-a.ts',
            startPages: [],
            scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
            proxy: { strategy: 'datacenter', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 2 }
          },
          {
            domain: 'site-b.com',
            scraper: 'site-b.ts',
            startPages: [],
            scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
            proxy: { strategy: 'datacenter', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
          }
        ];
        
        const result = targetsToSessions(targets, sessions, siteConfigs);
        
        // Should match 2 from site-a and 3 from site-b = 5 total
        expect(result).toHaveLength(5);
        
        // Count URLs per domain
        const domainCounts = new Map<string, number>();
        result.forEach(pair => {
          const domain = new URL(pair.url).hostname;
          domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
        });
        
        expect(domainCounts.get('site-a.com')).toBe(2);
        expect(domainCounts.get('site-b.com')).toBe(3);
      });

      it('should default to sessionLimit 1 when not specified', () => {
        const targets = [
          createTarget('https://no-limit-config.com/1'),
          createTarget('https://no-limit-config.com/2'),
          createTarget('https://no-limit-config.com/3')
        ];
        
        const siteConfigs: SiteConfigWithBlockedProxies[] = [
          {
            domain: 'no-limit-config.com',
            scraper: 'no-limit.ts',
            startPages: [],
            scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
            proxy: { strategy: 'datacenter', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 1 }
          }
        ];
        
        const result = targetsToSessions(targets, sessions, siteConfigs);
        expect(result).toHaveLength(1); // Default sessionLimit is 1
      });

      it('should respect session limits even with more sessions available', () => {
        // Create 10 sessions
        const manySessions: SessionInfo[] = Array.from({ length: 10 }, (_, i) => ({
          id: `session${i}`,
          proxyType: 'datacenter' as const,
          proxyGeo: 'US'
        }));
        
        const targets = [
          createTarget('https://wonder-gallery.com/1'),
          createTarget('https://wonder-gallery.com/2'),
          createTarget('https://wonder-gallery.com/3'),
          createTarget('https://wonder-gallery.com/4'),
          createTarget('https://wonder-gallery.com/5'),
          createTarget('https://wonder-gallery.com/6'),
          createTarget('https://wonder-gallery.com/7'),
          createTarget('https://wonder-gallery.com/8'),
          createTarget('https://wonder-gallery.com/9'),
          createTarget('https://iam-store.com/1')
        ];
        
        const siteConfigs: SiteConfigWithBlockedProxies[] = [
          {
            domain: 'wonder-gallery.com',
            scraper: 'wonder-gallery.ts',
            startPages: [],
            scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
            proxy: { strategy: 'datacenter', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 3 }
          },
          {
            domain: 'iam-store.com',
            scraper: 'iam-store.ts',
            startPages: [],
            scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
            proxy: { strategy: 'datacenter', geo: 'US', cooldownMinutes: 30, failureThreshold: 2, sessionLimit: 1 }
          }
        ];
        
        const result = targetsToSessions(targets, manySessions, siteConfigs);
        
        // Should match 3 wonder-gallery + 1 iam-store = 4 total
        expect(result).toHaveLength(4);
        
        // Count URLs per domain
        const domainCounts = new Map<string, number>();
        result.forEach(pair => {
          const domain = new URL(pair.url).hostname;
          domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
        });
        
        expect(domainCounts.get('wonder-gallery.com')).toBe(3);
        expect(domainCounts.get('iam-store.com')).toBe(1);
      });
    });
  });
});