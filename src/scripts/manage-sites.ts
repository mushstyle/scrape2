#!/usr/bin/env node

/**
 * Interactive CLI tool for managing site configurations
 * 
 * NOTE: This script directly calls the site-config driver which is architecturally
 * allowed since scripts are at the top layer and can call into any layer below.
 */

import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { getSiteConfig, addStartPages, replaceStartPages, removeStartPages } from '../drivers/site-config.js';
import { getSites } from '../providers/etl-api.js';
import { SiteManager } from '../services/site-manager.js';
import type { ScrapeRun } from '../types/scrape-run.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('manage-sites');

const rl = createInterface({ input, output });

async function selectDomain(): Promise<string | null> {
  try {
    // Get all sites
    const response = await getSites();
    const sites = response.sites || [];
    
    if (sites.length === 0) {
      console.log('No sites found.');
      return null;
    }
    
    // Sort sites alphabetically by domain
    const sortedSites = sites.sort((a: any, b: any) => {
      return a._id.localeCompare(b._id);
    });
    
    // Show sites with numbers
    console.log('\nAvailable sites:');
    sortedSites.forEach((site: any, index: number) => {
      const domain = site._id;
      const startPageCount = site.scrapeConfig?.startPages?.length || 0;
      console.log(`${index + 1}. ${domain} (${startPageCount} start pages)`);
    });
    
    // Get user selection
    const answer = await rl.question('\nSelect a site by number (or press Enter to cancel): ');
    
    if (!answer) return null;
    
    const index = parseInt(answer) - 1;
    if (index < 0 || index >= sites.length) {
      console.log('Invalid selection.');
      return null;
    }
    
    return sortedSites[index]._id;
  } catch (error) {
    log.error('Failed to get sites', { error });
    return null;
  }
}

async function getUrlsFromUser(prompt: string): Promise<string[]> {
  const answer = await rl.question(prompt);
  if (!answer.trim()) return [];
  
  // Split by comma or newline, trim each URL
  return answer
    .split(/[,\n]/)
    .map(url => url.trim())
    .filter(url => url.length > 0);
}

async function showCurrentStartPages(domain: string): Promise<void> {
  try {
    const config = await getSiteConfig(domain);
    const startPages = config.startPages || [];
    
    console.log(`\nCurrent start pages for ${domain}:`);
    if (startPages.length === 0) {
      console.log('  (none)');
    } else {
      startPages.forEach((url, index) => {
        console.log(`  ${index + 1}. ${url}`);
      });
    }
  } catch (error) {
    console.log(`Error loading current start pages: ${error.message}`);
  }
}

function parsePeriodToDate(period: string): Date | null {
  const now = new Date();
  const match = period.match(/^(\d+)([dwmh])$/i);
  
  if (!match) {
    return null;
  }
  
  const [, amount, unit] = match;
  const value = parseInt(amount, 10);
  
  switch (unit.toLowerCase()) {
    case 'd':
      now.setDate(now.getDate() - value);
      break;
    case 'w':
      now.setDate(now.getDate() - (value * 7));
      break;
    case 'h':
      now.setHours(now.getHours() - value);
      break;
    case 'm':
      now.setMinutes(now.getMinutes() - value);
      break;
    default:
      return null;
  }
  
  return now;
}

async function listSitesWithNoStartPages() {
  try {
    const response = await getSites();
    const sites = response.sites || [];
    
    const sitesWithNoStartPages = sites.filter((site: any) => {
      const startPageCount = site.scrapeConfig?.startPages?.length || 0;
      return startPageCount === 0;
    });
    
    if (sitesWithNoStartPages.length === 0) {
      console.log('\nAll sites have at least one start page.');
    } else {
      console.log(`\nSites with 0 start pages (${sitesWithNoStartPages.length} total):`);
      sitesWithNoStartPages
        .sort((a: any, b: any) => a._id.localeCompare(b._id))
        .forEach((site: any) => {
          console.log(`  - ${site._id}`);
        });
    }
  } catch (error) {
    console.log(`Error listing sites: ${error.message}`);
  }
}

async function listSitesWithOutstandingRuns(since?: Date) {
  try {
    // Initialize SiteManager
    const siteManager = new SiteManager();
    await siteManager.loadSites();
    
    // Debug log the since parameter
    if (since) {
      log.debug(`Filtering runs since: ${since.toISOString()}`);
    }
    
    // First, get all sites
    const response = await getSites();
    const allSites = response.sites || [];
    
    // Get the most recent outstanding run for each domain
    const latestRunByDomain = new Map<string, ScrapeRun>();
    
    // For each site, check if it has an outstanding run
    for (const site of allSites) {
      const domain = site._id;
      
      // Get the most recent run for this domain
      const runsResponse = await siteManager.listRuns({ 
        domain, 
        status: 'pending',
        limit: 1,
        sortBy: 'createdAt',
        sortOrder: 'desc'
      });
      
      if (runsResponse.runs.length === 0) {
        // Try processing status
        const processingResponse = await siteManager.listRuns({ 
          domain, 
          status: 'processing',
          limit: 1,
          sortBy: 'createdAt',
          sortOrder: 'desc'
        });
        
        if (processingResponse.runs.length > 0) {
          const run = processingResponse.runs[0];
          const runDate = new Date(run.created_at || run.createdAt || '');
          if (!since || runDate >= since) {
            latestRunByDomain.set(domain, run);
          }
        }
      } else {
        const run = runsResponse.runs[0];
        const runDate = new Date(run.created_at || run.createdAt || '');
        if (!since || runDate >= since) {
          latestRunByDomain.set(domain, run);
        }
      }
    }
    
    if (latestRunByDomain.size === 0) {
      console.log('\nNo sites have outstanding scrape runs.');
      return;
    }
    
    // Create table data showing statistics from the most recent run
    const tableData: Array<{
      Domain: string;
      Status: string;
      'Total Items': number;
      'Processed': number;
      'Failed': number;
      'Invalid': number;
      'Remaining': number;
      'Created': string;
    }> = [];
    
    latestRunByDomain.forEach((run, domain) => {
      const total = run.items?.length || 0;
      // Count actual item statuses instead of relying on metadata
      const processed = run.items?.filter((item: any) => item.done).length || 0;
      const failed = run.items?.filter((item: any) => item.failed).length || 0;
      const invalid = run.items?.filter((item: any) => item.invalid).length || 0;
      const remaining = total - processed - failed - invalid;
      
      tableData.push({
        Domain: domain,
        Status: run.status,
        'Total Items': total,
        'Processed': processed,
        'Failed': failed,
        'Invalid': invalid,
        'Remaining': remaining,
        'Created': run.created_at || run.createdAt ? new Date(run.created_at || run.createdAt || '').toLocaleString() : 'Unknown'
      });
    });
    
    // Sort alphabetically by domain name for consistent display
    tableData.sort((a, b) => a.Domain.localeCompare(b.Domain));
    
    const filterText = since ? ` (since ${since.toLocaleString()})` : '';
    console.log(`\nSites with outstanding scrape runs${filterText} (${tableData.length} sites):\n`);
    
    // Print table header
    console.log(
      'Domain'.padEnd(30) +
      'Status'.padEnd(12) +
      'Total'.padEnd(8) +
      'Processed'.padEnd(11) +
      'Failed'.padEnd(8) +
      'Invalid'.padEnd(9) +
      'Remaining'.padEnd(11) +
      'Created'
    );
    console.log('-'.repeat(110));
    
    // Print table rows
    tableData.forEach(row => {
      console.log(
        row.Domain.padEnd(30) +
        row.Status.padEnd(12) +
        row['Total Items'].toString().padEnd(8) +
        row['Processed'].toString().padEnd(11) +
        row['Failed'].toString().padEnd(8) +
        row['Invalid'].toString().padEnd(9) +
        row['Remaining'].toString().padEnd(11) +
        row['Created']
      );
    });
    
    // Calculate summary statistics
    const totalItems = tableData.reduce((sum, row) => sum + row['Total Items'], 0);
    const totalProcessed = tableData.reduce((sum, row) => sum + row['Processed'], 0);
    const totalFailed = tableData.reduce((sum, row) => sum + row['Failed'], 0);
    const totalInvalid = tableData.reduce((sum, row) => sum + row['Invalid'], 0);
    const totalRemaining = tableData.reduce((sum, row) => sum + row['Remaining'], 0);
    
    console.log('\nSummary:');
    console.log(`  Sites with outstanding runs: ${tableData.length}`);
    console.log(`  Total items across all runs: ${totalItems}`);
    console.log(`  Total processed: ${totalProcessed}`);
    console.log(`  Total failed: ${totalFailed}`);
    console.log(`  Total invalid: ${totalInvalid}`);
    console.log(`  Total remaining: ${totalRemaining}`);
    
  } catch (error) {
    console.log(`Error listing sites with outstanding runs: ${error.message}`);
  }
}

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let since: Date | undefined;
  
  // Check for --help
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: npm run sites:manage [options]');
    console.log('\nOptions:');
    console.log('  --since <date>  Filter scrape runs created after this date');
    console.log('                  Date format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss');
    console.log('\nTime Period Format (when prompted):');
    console.log('  1d    - Last 1 day');
    console.log('  24h   - Last 24 hours');
    console.log('  7d    - Last 7 days');
    console.log('  1w    - Last 1 week');
    console.log('  48h   - Last 48 hours');
    console.log('  30m   - Last 30 minutes');
    console.log('\nExample:');
    console.log('  npm run sites:manage --since 2024-01-15');
    console.log('  npm run sites:manage --since 2024-01-15T10:30:00');
    process.exit(0);
  }
  
  // Check for --since parameter
  const sinceIndex = args.findIndex(arg => arg === '--since');
  if (sinceIndex !== -1 && args[sinceIndex + 1]) {
    const sinceValue = args[sinceIndex + 1];
    since = new Date(sinceValue);
    if (isNaN(since.getTime())) {
      console.error(`Invalid date format for --since: ${sinceValue}`);
      console.log('Please use ISO format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)');
      process.exit(1);
    }
    console.log(`Filtering runs since: ${since.toISOString()}\n`);
  }
  
  console.log('=== Site Configuration Manager ===\n');
  
  let continueRunning = true;
  
  while (continueRunning) {
    // Show main menu
    console.log('\nWhat would you like to do?');
    console.log('1. Add start pages to a site');
    console.log('2. Replace all start pages for a site');
    console.log('3. Remove specific start pages from a site');
    console.log('4. View current start pages for a site');
    console.log('5. List sites with 0 start pages');
    console.log('6. List sites with outstanding scrape runs');
    console.log('7. Exit');
    
    const choice = await rl.question('\nEnter your choice (1-7): ');
    
    switch (choice) {
      case '1': {
        // Add start pages
        const domain = await selectDomain();
        if (!domain) break;
        
        await showCurrentStartPages(domain);
        
        const urls = await getUrlsFromUser('\nEnter URLs to add (comma or newline separated):\n');
        if (urls.length === 0) {
          console.log('No URLs provided.');
          break;
        }
        
        try {
          await addStartPages(domain, urls);
          console.log(`\n✓ Successfully added ${urls.length} start pages to ${domain}`);
          await showCurrentStartPages(domain);
        } catch (error) {
          console.log(`\n✗ Failed to add start pages: ${error.message}`);
        }
        break;
      }
      
      case '2': {
        // Replace all start pages
        const domain = await selectDomain();
        if (!domain) break;
        
        await showCurrentStartPages(domain);
        
        const confirm = await rl.question('\nThis will REPLACE all existing start pages. Continue? (y/N): ');
        if (confirm.toLowerCase() !== 'y') {
          console.log('Cancelled.');
          break;
        }
        
        const urls = await getUrlsFromUser('\nEnter new URLs (comma or newline separated):\n');
        if (urls.length === 0) {
          console.log('No URLs provided.');
          break;
        }
        
        try {
          await replaceStartPages(domain, urls);
          console.log(`\n✓ Successfully replaced start pages for ${domain} with ${urls.length} new URLs`);
          await showCurrentStartPages(domain);
        } catch (error) {
          console.log(`\n✗ Failed to replace start pages: ${error.message}`);
        }
        break;
      }
      
      case '3': {
        // Remove specific start pages
        const domain = await selectDomain();
        if (!domain) break;
        
        await showCurrentStartPages(domain);
        
        const config = await getSiteConfig(domain);
        if (!config.startPages || config.startPages.length === 0) {
          console.log('No start pages to remove.');
          break;
        }
        
        console.log('\nWhich URLs would you like to remove?');
        console.log('Enter the numbers of the URLs to remove (comma separated), or "all" to remove all:');
        
        const answer = await rl.question('> ');
        
        let urlsToRemove: string[] = [];
        
        if (answer.toLowerCase() === 'all') {
          urlsToRemove = config.startPages;
        } else {
          const indices = answer.split(',').map(s => parseInt(s.trim()) - 1);
          urlsToRemove = indices
            .filter(i => i >= 0 && i < config.startPages.length)
            .map(i => config.startPages[i]);
        }
        
        if (urlsToRemove.length === 0) {
          console.log('No valid URLs selected.');
          break;
        }
        
        try {
          await removeStartPages(domain, urlsToRemove);
          console.log(`\n✓ Successfully removed ${urlsToRemove.length} start pages from ${domain}`);
          await showCurrentStartPages(domain);
        } catch (error) {
          console.log(`\n✗ Failed to remove start pages: ${error.message}`);
        }
        break;
      }
      
      case '4': {
        // View start pages
        const domain = await selectDomain();
        if (!domain) break;
        
        await showCurrentStartPages(domain);
        break;
      }
      
      case '5': {
        // List sites with 0 start pages
        await listSitesWithNoStartPages();
        break;
      }
      
      case '6': {
        // List sites with outstanding runs
        // Ask for time period if not already provided via --since
        let filterSince = since;
        
        if (!filterSince) {
          const period = await rl.question('\nFilter by time period (e.g., 1d, 24h, 7d, 1w, or press Enter for 2d): ');
          
          if (period.trim()) {
            filterSince = parsePeriodToDate(period.trim());
            if (!filterSince) {
              console.log('Invalid time period format. Use format like: 1d, 24h, 7d, 1w, 30m');
              console.log('Defaulting to 2d.');
              filterSince = parsePeriodToDate('2d');
            }
          } else {
            // Default to 2d when user presses Enter
            filterSince = parsePeriodToDate('2d');
          }
        }
        
        await listSitesWithOutstandingRuns(filterSince);
        break;
      }
      
      case '7': {
        continueRunning = false;
        break;
      }
      
      default: {
        console.log('Invalid choice. Please enter 1-7.');
      }
    }
    
    if (continueRunning) {
      await rl.question('\nPress Enter to continue...');
    }
  }
  
  console.log('\nGoodbye!');
  rl.close();
}

// Run the tool
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});