/**
 * Example: Prepare URLs and site metadata for the distributor
 * Usage: npm run example:distributor -- --source start-pages
 * Usage: npm run example:distributor -- --source scrape-runs --since 7d
 * 
 * This example demonstrates:
 * - Getting URLs from different sources (start pages or scrape runs)
 * - Loading site configurations with proxy strategies
 * - Formatting data ready for the distributor function
 * - Showing how URLs would be distributed to sessions
 */

import { logger } from '../src/lib/logger.js';
import { getSites, listScrapeRuns } from '../src/providers/etl-api.js';
import { getSiteConfig } from '../src/providers/site-config.js';
import { itemsToSessions } from '../src/lib/distributor.js';
import type { SiteConfig } from '../src/types/site-config-types.js';
import type { ScrapeRunItem } from '../src/types/scrape-run.js';
import type { SessionInfo, SiteConfigWithBlockedProxies } from '../src/lib/distributor.js';

const log = logger.createContext('distributor-example');

interface UrlWithDomain {
  url: string;
  domain: string;
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
function parseArgs(): { source: 'start-pages' | 'scrape-runs'; since?: Date } {
  const args = process.argv.slice(2);
  const result: { source: 'start-pages' | 'scrape-runs'; since?: Date } = {
    source: 'start-pages'
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && i + 1 < args.length) {
      const source = args[i + 1];
      if (source === 'start-pages' || source === 'scrape-runs') {
        result.source = source;
      } else {
        throw new Error(`Invalid source: ${source}. Use 'start-pages' or 'scrape-runs'`);
      }
      i++; // Skip the next argument as it's the value
    } else if (args[i] === '--since' && i + 1 < args.length) {
      result.since = parseRelativeTime(args[i + 1]);
      i++; // Skip the next argument as it's the value
    }
  }

  return result;
}

/**
 * Get URLs from start pages
 */
async function getUrlsFromStartPages(): Promise<UrlWithDomain[]> {
  log.normal('Fetching URLs from start pages...');
  
  const sitesResponse = await getSites();
  const allSites = sitesResponse.data || sitesResponse.sites || [];
  
  const urls: UrlWithDomain[] = [];
  
  // Load site configurations and extract start pages
  const siteConfigs = await Promise.allSettled(
    allSites.map(async (site: any) => {
      try {
        const domain = site._id || site.id || site.domain;
        if (!domain) return null;
        
        const config = await getSiteConfig(domain);
        return config;
      } catch (error) {
        log.debug(`Failed to load config for site:`, error);
        return null;
      }
    })
  );

  // Extract URLs from start pages
  const validConfigs: SiteConfig[] = siteConfigs
    .filter((result) => result.status === 'fulfilled' && result.value !== null)
    .map((result: any) => result.value);

  for (const config of validConfigs) {
    if (config.startPages && config.startPages.length > 0) {
      const sessionLimit = config.proxy?.sessionLimit || 1;
      const selectedUrls = config.startPages.slice(0, sessionLimit);
      
      for (const url of selectedUrls) {
        urls.push({
          url,
          domain: config.domain
        });
      }
    }
  }

  return urls;
}

/**
 * Get URLs from scrape runs
 */
async function getUrlsFromScrapeRuns(since: Date): Promise<UrlWithDomain[]> {
  log.normal(`Fetching URLs from scrape runs since ${since.toISOString()}...`);
  
  const scrapeRunsResponse = await listScrapeRuns({ since });
  const allRuns = scrapeRunsResponse.runs || [];
  
  const urls: UrlWithDomain[] = [];
  
  // Group runs by domain (keep latest run per domain)
  const runsByDomain = new Map();
  for (const run of allRuns) {
    const existing = runsByDomain.get(run.domain);
    if (!existing || new Date(run.createdAt) > new Date(existing.createdAt)) {
      runsByDomain.set(run.domain, run);
    }
  }

  // Load site configs to get session limits
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

  // Extract URLs from run items
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
 * Create mock sessions for demonstration
 */
function createMockSessions(): SessionInfo[] {
  return [
    {
      id: 'session-dc-us-1',
      proxyType: 'datacenter',
      proxyId: 'dc-proxy-1',
      proxyGeo: 'US'
    },
    {
      id: 'session-dc-us-2',
      proxyType: 'datacenter',
      proxyId: 'dc-proxy-2',
      proxyGeo: 'US'
    },
    {
      id: 'session-res-us-1',
      proxyType: 'residential',
      proxyId: 'res-proxy-1',
      proxyGeo: 'US'
    },
    {
      id: 'session-none-1',
      proxyType: 'none',
      proxyId: undefined,
      proxyGeo: undefined
    }
  ];
}

async function main() {
  try {
    const { source, since } = parseArgs();
    
    if (source === 'scrape-runs' && !since) {
      log.error('--since parameter required when using scrape-runs source');
      process.exit(1);
    }
    
    log.normal(`Getting URLs from source: ${source}`);
    
    // Get URLs from the specified source
    let urlsWithDomains: UrlWithDomain[];
    if (source === 'start-pages') {
      urlsWithDomains = await getUrlsFromStartPages();
    } else {
      urlsWithDomains = await getUrlsFromScrapeRuns(since!);
    }

    if (urlsWithDomains.length === 0) {
      log.normal('No URLs found from the specified source');
      return;
    }

    log.normal(`Found ${urlsWithDomains.length} URLs`);

    // Get unique domains and load their configs
    const uniqueDomains = [...new Set(urlsWithDomains.map(u => u.domain))];
    log.normal(`Loading configurations for ${uniqueDomains.length} unique domains...`);

    const siteConfigs = await Promise.allSettled(
      uniqueDomains.map(async (domain) => {
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

    // Convert URLs to ScrapeRunItem format
    const scrapeRunItems: ScrapeRunItem[] = urlsWithDomains.map(({ url }) => ({
      url,
      done: false,
      failed: false
    }));

    // Create mock sessions for demonstration
    const mockSessions = createMockSessions();

    // Display preparation summary
    log.normal(`\n=== Distributor Data Summary ===`);
    log.normal(`Source: ${source}`);
    if (since) {
      log.normal(`Time range: since ${since.toISOString()}`);
    }
    log.normal(`Total URLs: ${scrapeRunItems.length}`);
    log.normal(`Site configs loaded: ${validConfigs.length}`);
    log.normal(`Mock sessions: ${mockSessions.length}`);

    // Show site configs breakdown
    log.normal(`\n=== Site Configurations ===`);
    for (const config of validConfigs) {
      const strategy = config.proxy?.strategy || 'none';
      const geo = config.proxy?.geo || 'any';
      const sessionLimit = config.proxy?.sessionLimit || 1;
      log.normal(`  ${config.domain}: ${strategy}/${geo} (limit: ${sessionLimit})`);
    }

    // Show mock sessions
    log.normal(`\n=== Mock Sessions ===`);
    for (const session of mockSessions) {
      const proxyInfo = session.proxyType === 'none' 
        ? 'no proxy' 
        : `${session.proxyType}/${session.proxyGeo}`;
      log.normal(`  ${session.id}: ${proxyInfo}`);
    }

    // Demonstrate distributor function
    log.normal(`\n=== Running Distributor ===`);
    const distribution = itemsToSessions(scrapeRunItems, mockSessions, validConfigs);
    
    log.normal(`Successfully distributed ${distribution.length}/${scrapeRunItems.length} URLs to sessions`);

    // Show first 10 distributions
    const displayDistribution = distribution.slice(0, 10);
    log.normal(`\n=== First ${displayDistribution.length} URL-Session Pairs ===`);
    
    displayDistribution.forEach((pair, index) => {
      const domain = extractDomain(pair.url);
      log.normal(`${(index + 1).toString().padStart(2)}: ${domain} → ${pair.sessionId}`);
    });

    if (distribution.length > 10) {
      log.normal(`\n... and ${distribution.length - 10} more pairs`);
    }

    // Show unmatched URLs
    const unmatchedCount = scrapeRunItems.length - distribution.length;
    if (unmatchedCount > 0) {
      log.normal(`\n⚠️  ${unmatchedCount} URLs could not be matched to suitable sessions`);
    }

    log.normal(`\nData is ready for distributor! 🚀`);

  } catch (error) {
    log.error('Example failed:', error);
    process.exit(1);
  }
}

main();