#!/usr/bin/env node

import { logger } from '../src/lib/logger.js';
import { getSiteConfig } from '../src/providers/site-config.js';
import { getLatestRunForDomain } from '../src/providers/etl-api.js';
import { parseArgs } from 'node:util';

const log = logger.createContext('site-info');

async function main() {
  // Parse command line arguments
  const { values } = parseArgs({
    options: {
      domain: {
        type: 'string',
        short: 'd'
      }
    }
  });

  if (!values.domain) {
    console.log('Usage: npm run site-info -- --domain=example.com');
    console.log('   or: npm run site-info -- -d example.com');
    process.exit(1);
  }

  const domain = values.domain;

  try {
    // 1. Get SiteConfig
    log.normal(`\nFetching site config for ${domain}...`);
    const siteConfig = await getSiteConfig(domain);
    log.normal('Site Config:', JSON.stringify(siteConfig, null, 2));

    // 2. Get start pages
    if (siteConfig.startPages && siteConfig.startPages.length > 0) {
      log.normal(`\nStart Pages (${siteConfig.startPages.length} total):`);
      siteConfig.startPages.forEach((url, index) => {
        log.normal(`  ${index + 1}. ${url}`);
      });
    } else {
      log.normal('\nNo start pages defined for this site');
    }

    // 3. Get pending scrape run
    log.normal(`\nChecking for pending scrape run...`);
    try {
      const scrapeRun = await getLatestRunForDomain(domain);
      
      if (scrapeRun) {
        log.normal(`Found scrape run: ${scrapeRun.id}`);
        log.normal(`  Status: ${scrapeRun.status}`);
        log.normal(`  Created: ${new Date(scrapeRun.createdAt).toLocaleString()}`);
        log.normal(`  Total items: ${scrapeRun.items.length}`);

        // Get pending items by filtering
        const pendingItems = scrapeRun.items.filter(item => !item.done && !item.failed);
        const pendingCount = pendingItems.length;
        const completedCount = scrapeRun.items.filter(item => item.done).length;
        const failedCount = scrapeRun.items.filter(item => item.failed).length;

        log.normal(`\nItem Status:`);
        log.normal(`  Pending: ${pendingCount}`);
        log.normal(`  Completed: ${completedCount}`);
        log.normal(`  Failed: ${failedCount}`);

        // Show first few pending URLs
        if (pendingCount > 0) {
          log.normal(`\nFirst ${Math.min(5, pendingCount)} pending URLs:`);
          pendingItems.slice(0, 5).forEach((item, index) => {
            log.normal(`  ${index + 1}. ${item.url}`);
          });
          if (pendingCount > 5) {
            log.normal(`  ... and ${pendingCount - 5} more`);
          }
        }
      } else {
        log.normal('No active scrape run found for this domain');
      }
    } catch (error) {
      log.normal('No scrape run found for this domain');
    }

  } catch (error) {
    log.error('Failed to fetch site information', { error });
    process.exit(1);
  }
}

// Run the script
main();