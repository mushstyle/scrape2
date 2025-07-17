#!/usr/bin/env node

/**
 * Get and display site configuration from API
 * 
 * Usage: npm run site:config:get -- <domain>
 * 
 * NOTE: This script directly calls the site-config driver which is architecturally
 * allowed since scripts are at the top layer and can call into any layer below.
 */

import { getSiteConfig } from '../drivers/site-config.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('get-site-config');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 1) {
    console.error('Usage: npm run site:config:get -- <domain>');
    console.error('Example: npm run site:config:get -- example.com');
    process.exit(1);
  }
  
  const domain = args[0];
  
  try {
    log.normal(`Fetching configuration for ${domain}...`);
    const config = await getSiteConfig(domain);
    
    console.log('\n=== Site Configuration ===');
    console.log(`Domain: ${config.domain}`);
    console.log(`Scraper: ${config.scraper}`);
    console.log(`Start Pages (${config.startPages.length}):`);
    config.startPages.forEach((url, index) => {
      console.log(`  ${index + 1}. ${url}`);
    });
    
    if (config.proxy) {
      console.log('\nProxy Configuration:');
      console.log(`  Strategy: ${config.proxy.strategy}`);
      console.log(`  Geo: ${config.proxy.geo}`);
      console.log(`  Cooldown: ${config.proxy.cooldownMinutes} minutes`);
      console.log(`  Failure Threshold: ${config.proxy.failureThreshold}`);
      console.log(`  Session Limit: ${config.proxy.sessionLimit}`);
    }
    
    if (config.scraping?.browser) {
      console.log('\nBrowser Configuration:');
      const browser = config.scraping.browser;
      if (browser.headless !== undefined) console.log(`  Headless: ${browser.headless}`);
      if (browser.userAgent) console.log(`  User Agent: ${browser.userAgent}`);
      if (browser.ignoreHttpsErrors) console.log(`  Ignore HTTPS Errors: ${browser.ignoreHttpsErrors}`);
      if (browser.viewport) console.log(`  Viewport: ${JSON.stringify(browser.viewport)}`);
      if (browser.args?.length) console.log(`  Args: ${browser.args.join(' ')}`);
      if (Object.keys(browser.headers || {}).length) {
        console.log(`  Headers: ${JSON.stringify(browser.headers)}`);
      }
    }
    
  } catch (error) {
    log.error(`Failed to get configuration for ${domain}`, { error });
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});