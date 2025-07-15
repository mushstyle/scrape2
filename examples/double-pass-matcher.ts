/**
 * Example: Double-pass URL-session matching algorithm
 * Usage: npm run example:double-pass-matcher -- --source start-pages --instance-limit 10
 * Usage: npm run example:double-pass-matcher -- --source scrape-runs --since 7d --instance-limit 5
 * 
 * This example demonstrates the efficient double-pass matching algorithm:
 * 1. Get URLs (respecting sessionLimit per domain)
 * 2. First pass: Match existing sessions to URLs
 * 3. Session allocation: Kill excess sessions, create new ones based on next URLs' needs
 * 4. Second pass: Run distributor again if new sessions were created
 * 
 * This maximizes efficiency by creating sessions that match upcoming URL requirements.
 */

import { logger } from '../src/utils/logger.js';
import { listScrapeRuns } from '../src/providers/etl-api.js';
import { getSiteConfig } from '../src/providers/site-config.js';
import { itemsToSessions } from '../src/core/distributor.js';
import { SiteManager } from '../src/services/site-manager.js';
import * as browserbase from '../src/providers/browserbase.js';
import * as localBrowser from '../src/providers/local-browser.js';
import type { SiteConfig } from '../src/types/site-config-types.js';
import type { ScrapeRunItem } from '../src/types/scrape-run.js';
import type { SessionInfo, SiteConfigWithBlockedProxies, UrlSessionPair } from '../src/core/distributor.js';
import type { Session, SessionOptions } from '../src/types/session.js';

const log = logger.createContext('double-pass-matcher');

interface UrlWithDomain {
  url: string;
  domain: string;
}

interface ProxyRequirement {
  type: 'residential' | 'datacenter' | 'none';
  geo?: string;
  count: number;
}

/**
 * Parse relative time strings like "7d", "48h", "30m"
 */
function parseRelativeTime(timeStr: string): Date {
  const match = timeStr.match(/^(\d+)([dhm])$/);
  if (!match) {
    throw new Error(`Invalid time format: ${timeStr}. Use format like "7d", "48h", "30m"`);
  }

  const [, amount, unit] = match;
  const now = new Date();
  const value = parseInt(amount, 10);

  switch (unit) {
    case 'd':
      return new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
    case 'h':
      return new Date(now.getTime() - value * 60 * 60 * 1000);
    case 'm':
      return new Date(now.getTime() - value * 60 * 1000);
    default:
      throw new Error(`Unsupported time unit: ${unit}`);
  }
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch (error) {
    log.debug(`Failed to parse URL: ${url}`);
    return '';
  }
}

/**
 * Parse command line arguments
 */
function parseArgs(): { source: 'start-pages' | 'scrape-runs'; since?: Date; instanceLimit: number; provider: 'browserbase' | 'local' } {
  const args = process.argv.slice(2);
  const result: { source: 'start-pages' | 'scrape-runs'; since?: Date; instanceLimit: number; provider: 'browserbase' | 'local' } = {
    source: 'start-pages',
    instanceLimit: 10,
    provider: 'browserbase'
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && i + 1 < args.length) {
      const source = args[i + 1];
      if (source === 'start-pages' || source === 'scrape-runs') {
        result.source = source;
      } else {
        throw new Error(`Invalid source: ${source}. Use 'start-pages' or 'scrape-runs'`);
      }
      i++;
    } else if (args[i] === '--since' && i + 1 < args.length) {
      result.since = parseRelativeTime(args[i + 1]);
      i++;
    } else if (args[i] === '--instance-limit' && i + 1 < args.length) {
      result.instanceLimit = parseInt(args[i + 1], 10);
      if (isNaN(result.instanceLimit) || result.instanceLimit < 1) {
        throw new Error('Instance limit must be a positive number');
      }
      i++;
    } else if (args[i] === '--provider' && i + 1 < args.length) {
      const provider = args[i + 1];
      if (provider === 'browserbase' || provider === 'local') {
        result.provider = provider;
      } else {
        throw new Error(`Invalid provider: ${provider}. Use 'browserbase' or 'local'`);
      }
      i++;
    }
  }

  return result;
}

/**
 * Get URLs from start pages using SiteManager
 */
async function getUrlsFromStartPages(siteManager: SiteManager): Promise<UrlWithDomain[]> {
  log.normal('Fetching URLs from start pages...');
  
  // Load sites if not already loaded
  if (!siteManager.isLoaded()) {
    await siteManager.loadSites();
  }
  
  // Get all start pages respecting sessionLimit
  const urls = siteManager.getAllStartPages();
  
  return urls;
}

/**
 * Load configs for specific domains
 */
async function loadConfigsForDomains(domains: string[]): Promise<SiteConfigWithBlockedProxies[]> {
  log.normal(`Loading configurations for ${domains.length} unique domains...`);

  const siteConfigs = await Promise.allSettled(
    domains.map(async (domain) => {
      try {
        const config = await getSiteConfig(domain);
        return config;
      } catch (error) {
        log.debug(`Failed to load config for domain ${domain}:`, error);
        return null;
      }
    })
  );

  const validConfigs: SiteConfigWithBlockedProxies[] = siteConfigs
    .filter((result) => result.status === 'fulfilled' && result.value !== null)
    .map((result: any) => result.value);

  return validConfigs;
}

/**
 * Get URLs from scrape runs
 */
async function getUrlsFromScrapeRuns(since: Date): Promise<UrlWithDomain[]> {
  log.normal(`Fetching URLs from scrape runs since ${since.toISOString()}...`);
  
  const scrapeRunsResponse = await listScrapeRuns({ since });
  const allRuns = scrapeRunsResponse.runs || [];
  
  const urls: UrlWithDomain[] = [];
  
  const runsByDomain = new Map();
  for (const run of allRuns) {
    const existing = runsByDomain.get(run.domain);
    if (!existing || new Date(run.createdAt) > new Date(existing.createdAt)) {
      runsByDomain.set(run.domain, run);
    }
  }

  const siteConfigs = await Promise.allSettled(
    Array.from(runsByDomain.keys()).map(async (domain) => {
      try {
        const config = await getSiteConfig(domain);
        return { domain, config };
      } catch (error) {
        log.debug(`Failed to load config for domain ${domain}:`, error);
        return null;
      }
    })
  );

  const validDomainConfigs = new Map<string, SiteConfig>();
  siteConfigs
    .filter((result) => result.status === 'fulfilled' && result.value !== null)
    .forEach((result: any) => {
      const { domain, config } = result.value;
      validDomainConfigs.set(domain, config);
    });

  for (const [domain, run] of runsByDomain) {
    const config = validDomainConfigs.get(domain);
    if (!config) continue;

    const sessionLimit = config.proxy?.sessionLimit || 1;
    const items = run.items || [];
    const itemUrls = items.map((item: any) => item.url).filter(Boolean);
    const selectedUrls = itemUrls.slice(0, sessionLimit);
    
    for (const url of selectedUrls) {
      urls.push({
        url,
        domain
      });
    }
  }

  return urls;
}

/**
 * Get active sessions from the provider
 */
async function getActiveSessions(provider: 'browserbase' | 'local'): Promise<Session[]> {
  log.debug(`Getting active sessions from ${provider}...`);
  
  if (provider === 'browserbase') {
    try {
      const bbSessions = await browserbase.listSessions();
      return bbSessions.map(bbSession => ({
        provider: 'browserbase',
        browserbase: bbSession,
        cleanup: async () => {
          await browserbase.terminateSession(bbSession.id);
        }
      }));
    } catch (error) {
      log.debug('Failed to get browserbase sessions:', error);
      return [];
    }
  } else {
    // Local provider doesn't have persistent sessions
    return [];
  }
}

/**
 * Convert Sessions to SessionInfo format for distributor
 */
function sessionsToSessionInfo(sessions: Session[]): SessionInfo[] {
  return sessions.map(session => {
    if (session.provider === 'browserbase') {
      return {
        id: session.browserbase!.id,
        proxyType: 'datacenter', // Browserbase uses datacenter proxies
        proxyId: `bb-${session.browserbase!.id}`,
        proxyGeo: 'US' // Default browserbase geo
      };
    } else {
      return {
        id: `local-${Math.random().toString(36).substr(2, 9)}`,
        proxyType: 'none',
        proxyId: undefined,
        proxyGeo: undefined
      };
    }
  });
}

/**
 * Analyze proxy requirements for a set of URLs
 */
function analyzeProxyRequirements(
  items: ScrapeRunItem[],
  siteConfigs: SiteConfigWithBlockedProxies[]
): ProxyRequirement[] {
  const requirements = new Map<string, ProxyRequirement>();
  
  for (const item of items) {
    const domain = extractDomain(item.url);
    const siteConfig = siteConfigs.find(config => config.domain === domain);
    
    if (!siteConfig || !siteConfig.proxy) {
      // No proxy required
      const key = 'none';
      const existing = requirements.get(key) || { type: 'none', count: 0 };
      existing.count++;
      requirements.set(key, existing);
      continue;
    }
    
    // Determine proxy type from strategy
    let proxyType: 'residential' | 'datacenter' | 'none' = 'datacenter';
    
    switch (siteConfig.proxy.strategy) {
      case 'none':
        proxyType = 'none';
        break;
      case 'datacenter':
        proxyType = 'datacenter';
        break;
      case 'residential-stable':
      case 'residential-rotating':
        proxyType = 'residential';
        break;
      case 'datacenter-to-residential':
        // Prefer datacenter for this strategy
        proxyType = 'datacenter';
        break;
    }
    
    const key = `${proxyType}-${siteConfig.proxy.geo || 'any'}`;
    const existing = requirements.get(key) || {
      type: proxyType,
      geo: siteConfig.proxy.geo,
      count: 0
    };
    existing.count++;
    requirements.set(key, existing);
  }
  
  return Array.from(requirements.values());
}

/**
 * Create sessions based on proxy requirements
 */
async function createSessionsForRequirements(
  requirements: ProxyRequirement[],
  provider: 'browserbase' | 'local'
): Promise<Session[]> {
  const sessions: Session[] = [];
  
  for (const req of requirements) {
    log.debug(`Creating ${req.count} sessions for ${req.type}/${req.geo || 'any'}`);
    
    for (let i = 0; i < req.count; i++) {
      try {
        const options: SessionOptions = {};
        
        // For browserbase, we can't control proxy type directly
        // but we can set other options
        if (provider === 'browserbase') {
          options.timeout = 60; // Default timeout
        }
        
        const session = provider === 'browserbase' 
          ? await browserbase.createSession(options)
          : await localBrowser.createSession(options);
          
        sessions.push(session);
      } catch (error) {
        log.debug(`Failed to create session:`, error);
      }
    }
  }
  
  return sessions;
}

/**
 * Terminate excess sessions
 */
async function terminateExcessSessions(excessSessions: SessionInfo[], allSessions: Session[]): Promise<void> {
  if (excessSessions.length === 0) {
    return;
  }
  
  log.normal(`Terminating ${excessSessions.length} excess sessions...`);
  
  const excessSessionIds = new Set(excessSessions.map(s => s.id));
  const sessionsToTerminate = allSessions.filter(session => {
    const sessionId = session.provider === 'browserbase' 
      ? session.browserbase!.id 
      : `local-${session}`;
    return excessSessionIds.has(sessionId);
  });
  
  await Promise.allSettled(
    sessionsToTerminate.map(async (session) => {
      try {
        await session.cleanup();
        log.debug(`Terminated session: ${session.provider === 'browserbase' ? session.browserbase!.id : 'local'}`);
      } catch (error) {
        log.debug(`Failed to terminate session:`, error);
      }
    })
  );
}

async function main() {
  try {
    const { source, since, instanceLimit, provider } = parseArgs();
    
    if (source === 'scrape-runs' && !since) {
      log.error('--since parameter required when using scrape-runs source');
      process.exit(1);
    }
    
    log.normal(`Double-pass matcher with instance limit: ${instanceLimit}`);
    log.normal(`Source: ${source}, Provider: ${provider}`);
    
    // Initialize SiteManager
    const siteManager = new SiteManager();
    
    // Step 1: Get URLs from the specified source
    log.normal(`\n=== Step 1: Get URLs ===`);
    let urlsWithDomains: UrlWithDomain[];
    if (source === 'start-pages') {
      urlsWithDomains = await getUrlsFromStartPages(siteManager);
    } else {
      urlsWithDomains = await getUrlsFromScrapeRuns(since!);
    }

    if (urlsWithDomains.length === 0) {
      log.normal('No URLs found from the specified source');
      return;
    }

    log.normal(`Found ${urlsWithDomains.length} total URLs`);

    // Get site configs from SiteManager
    const validConfigs: SiteConfigWithBlockedProxies[] = source === 'start-pages' 
      ? siteManager.getSiteConfigs()
      : await loadConfigsForDomains([...new Set(urlsWithDomains.map(u => u.domain))]);

    // Convert URLs to ScrapeRunItem format
    const scrapeRunItems: ScrapeRunItem[] = urlsWithDomains.map(({ url }) => ({
      url,
      done: false,
      failed: false
    }));

    // Step 2: First Pass - Match existing sessions to URLs
    log.normal(`\n=== Step 2: First Pass - Match Existing Sessions ===`);
    
    let allSessions = await getActiveSessions(provider);
    let sessionInfos = sessionsToSessionInfo(allSessions);
    
    log.normal(`Found ${allSessions.length} existing sessions`);
    
    let matched = itemsToSessions(scrapeRunItems, sessionInfos, validConfigs);
    log.normal(`First pass matched: ${matched.length} URL-session pairs`);
    
    // Find excess sessions
    const usedSessionIds = new Set(matched.map(pair => pair.sessionId));
    const excessSessions = sessionInfos.filter(session => !usedSessionIds.has(session.id));
    
    // Step 3: Session Allocation
    log.normal(`\n=== Step 3: Session Allocation ===`);
    
    // Kill excess sessions
    if (excessSessions.length > 0) {
      await terminateExcessSessions(excessSessions, allSessions);
      // Remove terminated sessions from our lists
      allSessions = allSessions.filter(session => {
        const sessionId = session.provider === 'browserbase' 
          ? session.browserbase!.id 
          : `local-${session}`;
        return !excessSessions.find(e => e.id === sessionId);
      });
      sessionInfos = sessionsToSessionInfo(allSessions);
    }
    
    // Check if we need more sessions
    const sessionsNeeded = instanceLimit - matched.length;
    
    if (sessionsNeeded > 0 && matched.length < scrapeRunItems.length) {
      log.normal(`Need ${sessionsNeeded} more sessions to reach instance limit`);
      
      // Find unmatched URLs
      const matchedUrls = new Set(matched.map(pair => pair.url));
      const unmatchedItems = scrapeRunItems.filter(item => !matchedUrls.has(item.url));
      
      // Analyze proxy requirements for the next N URLs
      const nextItems = unmatchedItems.slice(0, sessionsNeeded);
      log.normal(`Analyzing proxy requirements for next ${nextItems.length} URLs...`);
      
      const requirements = analyzeProxyRequirements(nextItems, validConfigs);
      
      // Show proxy requirements
      log.normal(`Proxy requirements:`);
      requirements.forEach(req => {
        log.normal(`  ${req.type}/${req.geo || 'any'}: ${req.count} sessions`);
      });
      
      // Create new sessions based on requirements
      const newSessions = await createSessionsForRequirements(requirements, provider);
      
      if (newSessions.length > 0) {
        log.normal(`Created ${newSessions.length} new sessions`);
        
        // Step 4: Second Pass
        log.normal(`\n=== Step 4: Second Pass - Match All Sessions ===`);
        
        // Update our session lists
        allSessions = [...allSessions, ...newSessions];
        sessionInfos = sessionsToSessionInfo(allSessions);
        
        // Run distributor again
        matched = itemsToSessions(scrapeRunItems, sessionInfos, validConfigs);
        log.normal(`Second pass matched: ${matched.length} URL-session pairs`);
      } else {
        log.normal('No new sessions created');
      }
    } else if (matched.length === instanceLimit) {
      log.normal('Already at instance limit, no new sessions needed');
    } else {
      log.normal('All URLs matched, no new sessions needed');
    }
    
    // Final Summary
    log.normal(`\n=== Final Results ===`);
    log.normal(`Total URLs: ${scrapeRunItems.length}`);
    log.normal(`Instance limit: ${instanceLimit}`);
    log.normal(`Total sessions: ${allSessions.length}`);
    log.normal(`Matched URL-session pairs: ${matched.length}`);
    log.normal(`Efficiency: ${((matched.length / instanceLimit) * 100).toFixed(1)}%`);
    
    // Show matched pairs (first 10)
    if (matched.length > 0) {
      log.normal(`\nFirst ${Math.min(10, matched.length)} matches:`);
      matched.slice(0, 10).forEach((pair, index) => {
        const domain = extractDomain(pair.url);
        log.normal(`  ${(index + 1).toString().padStart(2)}: ${domain} → ${pair.sessionId}`);
      });
      if (matched.length > 10) {
        log.normal(`  ... and ${matched.length - 10} more`);
      }
    }
    
    log.normal(`\nDouble-pass matching completed! 🎯`);
    
    // Cleanup: Kill all sessions
    log.normal(`\nCleaning up ${allSessions.length} sessions...`);
    await Promise.allSettled(
      allSessions.map(async (session) => {
        try {
          await session.cleanup();
          log.debug(`Terminated session: ${session.provider === 'browserbase' ? session.browserbase!.id : 'local'}`);
        } catch (error) {
          log.debug(`Failed to terminate session:`, error);
        }
      })
    );
    log.normal('Cleanup completed');

  } catch (error) {
    log.error('Example failed:', error);
    process.exit(1);
  }
}

main();