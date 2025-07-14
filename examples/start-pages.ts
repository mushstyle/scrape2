/**
 * Example: Get start pages from all sites with session limits
 * Usage: npm run example:start-pages
 * 
 * This example demonstrates:
 * - Fetching all sites from the ETL API
 * - Getting site configurations with proxy strategies
 * - Respecting sessionLimit for each site
 * - Collecting and displaying start page URLs
 */

import { logger } from '../src/lib/logger.js';
import { getSites } from '../src/providers/etl-api.js';
import { getSiteConfig } from '../src/providers/site-config.js';
import type { SiteConfig } from '../src/types/site-config-types.js';

const log = logger.createContext('start-pages-example');

interface SiteWithUrls {
  domain: string;
  sessionLimit: number;
  startPages: string[];
  selectedUrls: string[];
}

async function main() {
  try {
    log.normal('Fetching all sites from ETL API...');
    
    // Get all sites from the API
    const sitesResponse = await getSites();
    const allSites = sitesResponse.data || sitesResponse.sites || [];
    
    if (!Array.isArray(allSites) || allSites.length === 0) {
      log.error('No sites found or invalid response format');
      return;
    }

    log.normal(`Found ${allSites.length} sites, loading configurations...`);

    // Load site configurations in parallel
    const siteConfigs = await Promise.allSettled(
      allSites.map(async (site: any) => {
        try {
          const domain = site._id || site.id || site.domain;
          if (!domain) {
            log.debug('Skipping site with no domain identifier');
            return null;
          }
          
          const config = await getSiteConfig(domain);
          return config;
        } catch (error) {
          log.debug(`Failed to load config for site ${site._id || site.id}:`, error);
          return null;
        }
      })
    );

    // Filter successful configs and sites with start pages
    const validConfigs: SiteConfig[] = siteConfigs
      .filter((result) => result.status === 'fulfilled' && result.value !== null)
      .map((result: any) => result.value);

    const scrapeableSites = validConfigs.filter(config => 
      config.startPages && config.startPages.length > 0
    );

    log.normal(`Found ${scrapeableSites.length} scrapeable sites (with start pages)`);

    if (scrapeableSites.length === 0) {
      log.error('No scrapeable sites found');
      return;
    }

    // Process each site and respect session limits
    const sitesWithUrls: SiteWithUrls[] = [];
    let totalUrls = 0;

    for (const config of scrapeableSites) {
      const sessionLimit = config.proxy?.sessionLimit || 1;
      const availableUrls = config.startPages;
      
      // Select up to sessionLimit URLs from start pages
      const selectedUrls = availableUrls.slice(0, sessionLimit);
      
      sitesWithUrls.push({
        domain: config.domain,
        sessionLimit,
        startPages: availableUrls,
        selectedUrls
      });

      totalUrls += selectedUrls.length;
    }

    // Sort by domain for consistent output
    sitesWithUrls.sort((a, b) => a.domain.localeCompare(b.domain));

    // Collect all selected URLs
    const allSelectedUrls: string[] = [];
    for (const site of sitesWithUrls) {
      allSelectedUrls.push(...site.selectedUrls);
    }

    // Display summary
    log.normal(`\n=== Start Pages Summary ===`);
    log.normal(`Total scrapeable sites: ${sitesWithUrls.length}`);
    log.normal(`Total selected URLs: ${totalUrls}`);
    log.normal(`\nSite breakdown:`);
    
    for (const site of sitesWithUrls) {
      const total = site.startPages.length;
      const selected = site.selectedUrls.length;
      log.normal(`  ${site.domain}: ${selected}/${total} URLs (limit: ${site.sessionLimit})`);
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