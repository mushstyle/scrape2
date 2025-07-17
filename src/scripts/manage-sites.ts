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
    
    // Show sites with numbers
    console.log('\nAvailable sites:');
    sites.forEach((site: any, index: number) => {
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
    
    return sites[index]._id;
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
    console.log('5. Exit');
    
    const choice = await rl.question('\nEnter your choice (1-5): ');
    
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
        continueRunning = false;
        break;
      }
      
      default: {
        console.log('Invalid choice. Please enter 1-5.');
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