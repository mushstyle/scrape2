/**
 * Example: Get URLs from scrape run items with session limits
 * Usage: npm run example:scrape-run-urls -- --since 7d
 * 
 * This example demonstrates:
 * - Fetching scrape runs from the ETL API with time filters
 * - Getting URLs from scrape run items
 * - Respecting sessionLimit for each site
 * - Collecting and displaying item URLs
 */

import { logger } from '../src/lib/logger.js';
import { listScrapeRuns } from '../src/providers/etl-api.js';
import { getSiteConfig } from '../src/providers/site-config.js';
import type { SiteConfig } from '../src/types/site-config-types.js';
import type { ScrapeRun } from '../src/types/scrape-run.js';

const log = logger.createContext('scrape-run-urls-example');

interface SiteWithUrls {
  domain: string;
  sessionLimit: number;
  runId: string;
  totalItems: number;
  selectedUrls: string[];
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
 * Parse command line arguments
 */
function parseArgs(): { since?: Date } {
  const args = process.argv.slice(2);
  const result: { since?: Date } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--since' && i + 1 < args.length) {
      result.since = parseRelativeTime(args[i + 1]);
      i++; // Skip the next argument as it's the value
    }
  }

  return result;
}

async function main() {
  try {
    const { since } = parseArgs();
    
    if (!since) {
      log.error('Missing required --since parameter. Usage: npm run example:scrape-run-urls -- --since 7d');
      process.exit(1);
    }

    log.normal(`Fetching scrape runs since ${since.toISOString()}...`);
    
    // Get scrape runs from the API
    const scrapeRunsResponse = await listScrapeRuns({ since });
    const allRuns = scrapeRunsResponse.runs || [];
    
    if (allRuns.length === 0) {
      log.normal('No scrape runs found for the specified time period');
      return;
    }

    log.normal(`Found ${allRuns.length} scrape runs, processing...`);

    // Group runs by domain (keep latest run per domain)
    const runsByDomain = new Map<string, ScrapeRun>();
    
    for (const run of allRuns) {
      const existing = runsByDomain.get(run.domain);
      if (!existing || new Date(run.createdAt) > new Date(existing.createdAt)) {
        runsByDomain.set(run.domain, run);
      }
    }

    log.normal(`Processing ${runsByDomain.size} unique domains...`);

    // Load site configurations in parallel
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

    // Filter successful configs
    const validDomainConfigs = new Map<string, SiteConfig>();
    siteConfigs
      .filter((result) => result.status === 'fulfilled' && result.value !== null)
      .forEach((result: any) => {
        const { domain, config } = result.value;
        validDomainConfigs.set(domain, config);
      });

    log.normal(`Loaded configurations for ${validDomainConfigs.size} domains`);

    // Process each domain and respect session limits
    const sitesWithUrls: SiteWithUrls[] = [];
    let totalUrls = 0;

    for (const [domain, run] of runsByDomain) {
      const config = validDomainConfigs.get(domain);
      if (!config) {
        log.debug(`Skipping ${domain} - no configuration available`);
        continue;
      }

      const sessionLimit = config.proxy?.sessionLimit || 1;
      const items = run.items || [];
      
      // Get all URLs from items
      const itemUrls = items.map(item => item.url).filter(Boolean);
      
      if (itemUrls.length === 0) {
        log.debug(`Skipping ${domain} - no items with URLs`);
        continue;
      }
      
      // Select up to sessionLimit URLs from items
      const selectedUrls = itemUrls.slice(0, sessionLimit);
      
      sitesWithUrls.push({
        domain,
        sessionLimit,
        runId: run.id,
        totalItems: itemUrls.length,
        selectedUrls
      });

      totalUrls += selectedUrls.length;
    }

    if (sitesWithUrls.length === 0) {
      log.normal('No sites with items found');
      return;
    }

    // Sort by domain for consistent output
    sitesWithUrls.sort((a, b) => a.domain.localeCompare(b.domain));

    // Collect all selected URLs
    const allSelectedUrls: string[] = [];
    for (const site of sitesWithUrls) {
      allSelectedUrls.push(...site.selectedUrls);
    }

    // Display summary
    log.normal(`\n=== Scrape Run URLs Summary ===`);
    log.normal(`Time range: since ${since.toISOString()}`);
    log.normal(`Total domains with items: ${sitesWithUrls.length}`);
    log.normal(`Total selected URLs: ${totalUrls}`);
    log.normal(`\nDomain breakdown:`);
    
    for (const site of sitesWithUrls) {
      const selected = site.selectedUrls.length;
      const total = site.totalItems;
      log.normal(`  ${site.domain}: ${selected}/${total} URLs (limit: ${site.sessionLimit}, run: ${site.runId})`);
    }

    // Display first 30 URLs
    const displayUrls = allSelectedUrls.slice(0, 30);
    log.normal(`\n=== First ${displayUrls.length} URLs ===`);
    
    displayUrls.forEach((url, index) => {
      log.normal(`${(index + 1).toString().padStart(2)}: ${url}`);
    });

    if (allSelectedUrls.length > 30) {
      log.normal(`\n... and ${allSelectedUrls.length - 30} more URLs`);
    }

    log.normal(`\nExample completed successfully!`);

  } catch (error) {
    log.error('Example failed:', error);
    process.exit(1);
  }
}

main();