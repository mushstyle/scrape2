#!/usr/bin/env node

/**
 * Set or update site scraping configuration via API
 * 
 * Usage: npm run site:config:set -- <domain> <scraper-file.ts> <startPage1[,startPage2,...]>
 * 
 * NOTE: This script directly calls the ETL API provider which is architecturally
 * allowed since scripts are at the top layer and can call into any layer below.
 */

import { updateSiteScrapingConfig, getSiteById } from '../providers/etl-api.js';
import { logger } from '../utils/logger.js';
import { extractDomain } from '../utils/url-utils.js';

const log = logger.createContext('set-site-config');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    console.error('Usage: npm run site:config:set -- <domain> <scraper-file.ts> <startPage1[,startPage2,...]>');
    console.error('Example: npm run site:config:set -- example.com example.com.ts https://example.com/products,https://example.com/sale');
    process.exit(1);
  }
  
  const domain = extractDomain(args[0]);
  const scraperFile = args[1];
  const startPagesArg = args[2];
  
  // Parse start pages (comma-separated)
  const startPages = startPagesArg.split(',').map(url => url.trim()).filter(url => url.length > 0);
  
  if (startPages.length === 0) {
    console.error('Error: At least one start page URL is required');
    process.exit(1);
  }
  
  // Validate scraper filename
  if (!scraperFile.endsWith('.ts')) {
    console.error('Error: Scraper file must end with .ts');
    process.exit(1);
  }
  
  try {
    // First check if site exists
    log.normal(`Checking if site ${domain} exists...`);
    try {
      await getSiteById(domain);
      log.normal(`Site ${domain} found`);
    } catch (error) {
      log.error(`Site ${domain} not found. You may need to create it first.`, { error });
      console.error(`\nError: Site ${domain} does not exist in the database.`);
      console.error('Please ensure the site is registered before setting scraping configuration.');
      process.exit(1);
    }
    
    // Update the scraping configuration
    log.normal(`Updating scraping configuration for ${domain}...`);
    
    const config = {
      scrapeConfig: {
        scraperFile: scraperFile,
        startPages: startPages
      }
    };
    
    await updateSiteScrapingConfig(domain, config);
    
    console.log('\n✓ Successfully updated scraping configuration');
    console.log(`  Domain: ${domain}`);
    console.log(`  Scraper: ${scraperFile}`);
    console.log(`  Start Pages (${startPages.length}):`);
    startPages.forEach((url, index) => {
      console.log(`    ${index + 1}. ${url}`);
    });
    
    console.log('\nTo verify: npm run site:config:get -- ' + domain);
    
  } catch (error) {
    log.error(`Failed to update configuration for ${domain}`, { error });
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});