#!/usr/bin/env node

import { logger } from '../src/utils/logger.js';
import { SiteManager } from '../src/services/site-manager.js';
import { parseArgs } from 'node:util';

const log = logger.createContext('site-info');

function parseRelativeTime(timeStr: string): Date {
  const match = timeStr.match(/^(\d+)([hd])$/);
  if (!match) {
    throw new Error('Invalid time format. Use format like "48h" or "7d"');
  }
  
  const [, amount, unit] = match;
  const value = parseInt(amount, 10);
  const now = Date.now();
  
  let milliseconds: number;
  if (unit === 'h') {
    milliseconds = value * 60 * 60 * 1000;
  } else if (unit === 'd') {
    milliseconds = value * 24 * 60 * 60 * 1000;
  } else {
    throw new Error('Invalid time unit. Use "h" for hours or "d" for days');
  }
  
  return new Date(now - milliseconds);
}

async function main() {
  // Parse command line arguments
  const { values } = parseArgs({
    options: {
      domain: {
        type: 'string',
        short: 'd'
      },
      since: {
        type: 'string',
        short: 's'
      }
    }
  });

  if (!values.domain) {
    console.log('Usage: npm run example:site-info -- --domain=example.com [--since=48h]');
    console.log('   or: npm run example:site-info -- -d example.com [-s 7d]');
    console.log('\nExamples:');
    console.log('  --since=24h   # Last 24 hours');
    console.log('  --since=7d    # Last 7 days');
    process.exit(1);
  }

  const domain = values.domain;
  let sinceDate: Date | undefined;
  
  if (values.since) {
    try {
      sinceDate = parseRelativeTime(values.since);
      log.normal(`Filtering runs since: ${sinceDate.toLocaleString()}`);
    } catch (error) {
      log.error(`Invalid since parameter: ${values.since}`);
      console.log('Use format like "48h" or "7d"');
      process.exit(1);
    }
  }

  // Initialize services
  const siteManager = new SiteManager();
  
  try {
    // Load sites
    await siteManager.loadSites();
    
    // 1. Get SiteConfig
    log.normal(`\nFetching site config for ${domain}...`);
    const siteConfig = siteManager.getSiteConfig(domain);
    
    if (!siteConfig) {
      log.error(`Site config not found for domain: ${domain}`);
      process.exit(1);
    }
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
    log.normal(`\nChecking for scrape runs...`);
    try {
      const runsResponse = await siteManager.listRuns({
        domain,
        since: sinceDate
      });
      
      if (runsResponse.runs && runsResponse.runs.length > 0) {
        log.normal(`Found ${runsResponse.runs.length} scrape run(s)`);
        
        // Show the most recent run
        const latestRun = runsResponse.runs[0];
        log.normal(`\nMost recent run: ${latestRun.id}`);
        log.normal(`  Status: ${latestRun.status}`);
        log.normal(`  Created: ${new Date(latestRun.createdAt).toLocaleString()}`);
        log.normal(`  Total items: ${latestRun.items.length}`);

        // Get pending items by filtering
        const pendingItems = latestRun.items.filter(item => !item.done && !item.failed);
        const pendingCount = pendingItems.length;
        const completedCount = latestRun.items.filter(item => item.done).length;
        const failedCount = latestRun.items.filter(item => item.failed).length;

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
        
        // Show other runs if any
        if (runsResponse.runs.length > 1) {
          log.normal(`\nOther runs found:`);
          runsResponse.runs.slice(1).forEach((run, index) => {
            const runPending = run.items.filter(item => !item.done && !item.failed).length;
            log.normal(`  ${index + 2}. ${run.id} - Status: ${run.status}, Items: ${run.items.length}, Pending: ${runPending}`);
          });
        }
      } else {
        log.normal('No scrape runs found for this domain' + (sinceDate ? ` since ${sinceDate.toLocaleString()}` : ''));
      }
    } catch (error) {
      log.normal('Error fetching scrape runs');
      log.debug('Error details:', { error });
    }

  } catch (error) {
    log.error('Failed to fetch site information', { error });
    process.exit(1);
  }
}

// Run the script
main();