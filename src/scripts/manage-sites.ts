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
import { listRuns } from '../drivers/scrape-runs.js';
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

async function listSitesWithOutstandingRuns() {
  try {
    // Get all sites
    const response = await getSites();
    const sites = response.sites || [];
    
    // Get all pending/processing runs
    const pendingRunsResponse = await listRuns({ status: 'pending' });
    const processingRunsResponse = await listRuns({ status: 'processing' });
    
    const pendingRuns = pendingRunsResponse.runs || [];
    const processingRuns = processingRunsResponse.runs || [];
    const allOutstandingRuns = [...pendingRuns, ...processingRuns];
    
    if (allOutstandingRuns.length === 0) {
      console.log('\nNo sites have outstanding scrape runs.');
      return;
    }
    
    // Group runs by domain
    const runsByDomain = new Map<string, { pending: number; processing: number; latestDate: string }>();
    
    allOutstandingRuns.forEach(run => {
      const current = runsByDomain.get(run.domain) || { pending: 0, processing: 0, latestDate: '' };
      
      if (run.status === 'pending') {
        current.pending++;
      } else if (run.status === 'processing') {
        current.processing++;
      }
      
      // Keep track of the most recent run date
      const runDate = run.created_at || run.createdAt || '';
      if (!current.latestDate || runDate > current.latestDate) {
        current.latestDate = runDate;
      }
      
      runsByDomain.set(run.domain, current);
    });
    
    // Create table data
    const tableData: Array<{
      Domain: string;
      'Pending Runs': number;
      'Processing Runs': number;
      'Total Outstanding': number;
      'Latest Run Created': string;
    }> = [];
    
    runsByDomain.forEach((runInfo, domain) => {
      tableData.push({
        Domain: domain,
        'Pending Runs': runInfo.pending,
        'Processing Runs': runInfo.processing,
        'Total Outstanding': runInfo.pending + runInfo.processing,
        'Latest Run Created': runInfo.latestDate ? new Date(runInfo.latestDate).toLocaleString() : 'Unknown'
      });
    });
    
    // Sort by total outstanding runs (descending), then by domain name
    tableData.sort((a, b) => {
      const totalDiff = b['Total Outstanding'] - a['Total Outstanding'];
      return totalDiff !== 0 ? totalDiff : a.Domain.localeCompare(b.Domain);
    });
    
    console.log(`\nSites with outstanding scrape runs (${tableData.length} sites, ${allOutstandingRuns.length} total runs):\n`);
    
    // Print table header
    console.log('%-30s %-12s %-15s %-17s %-20s'.replace(
      /%-(\d+)s/g,
      (_, width) => ''.padEnd(Number(width))
    ));
    console.log(
      'Domain'.padEnd(30) +
      'Pending'.padEnd(12) +
      'Processing'.padEnd(15) +
      'Total Outstanding'.padEnd(17) +
      'Latest Run Created'
    );
    console.log('-'.repeat(94));
    
    // Print table rows
    tableData.forEach(row => {
      console.log(
        row.Domain.padEnd(30) +
        row['Pending Runs'].toString().padEnd(12) +
        row['Processing Runs'].toString().padEnd(15) +
        row['Total Outstanding'].toString().padEnd(17) +
        row['Latest Run Created']
      );
    });
    
    console.log('\nSummary:');
    console.log(`  Total pending runs: ${pendingRuns.length}`);
    console.log(`  Total processing runs: ${processingRuns.length}`);
    console.log(`  Total outstanding runs: ${allOutstandingRuns.length}`);
    
  } catch (error) {
    console.log(`Error listing sites with outstanding runs: ${error.message}`);
  }
}

async function main() {
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
        await listSitesWithOutstandingRuns();
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