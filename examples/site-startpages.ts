#!/usr/bin/env tsx --env-file=.env

/**
 * Site StartPages Example
 * 
 * Loads the SiteManager and displays the number of startPages for each site
 */

import { SiteManager } from '../src/services/site-manager.js';
import { logger } from '../src/utils/logger.js';

const log = logger.createContext('site-startpages');

async function main() {
  const siteManager = new SiteManager();
  
  try {
    // Load all sites from the ETL API
    log.normal('Loading sites from ETL API...');
    await siteManager.loadSites();
    
    // Get all sites
    const allSites = siteManager.getAllSites();
    log.normal(`Loaded ${allSites.length} sites\n`);
    
    // Sort sites by number of startPages (descending)
    const sitesWithStartPages = allSites
      .map(site => ({
        domain: site.domain,
        startPagesCount: site.config.startPages?.length || 0,
        startPages: site.config.startPages || []
      }))
      .sort((a, b) => b.startPagesCount - a.startPagesCount);
    
    // Display as a table
    console.log('\n=== Sites StartPages Table ===\n');
    
    // Calculate column widths
    const maxDomainLength = Math.max(...sitesWithStartPages.map(s => s.domain.length), 6); // min 6 for "Domain"
    const domainWidth = Math.min(maxDomainLength + 2, 40); // cap at 40
    
    // Print header
    console.log(`${'Domain'.padEnd(domainWidth)} | ${'StartPages'.padStart(10)} | First StartPage URL`);
    console.log(`${'-'.repeat(domainWidth)}-+-${'-'.repeat(10)}-+-${'-'.repeat(50)}`);
    
    // Print rows
    sitesWithStartPages.forEach(site => {
      const domain = site.domain.length > domainWidth - 2 
        ? site.domain.substring(0, domainWidth - 5) + '...' 
        : site.domain;
      const count = site.startPagesCount.toString().padStart(10);
      const firstUrl = site.startPages[0] 
        ? (site.startPages[0].length > 50 
            ? '...' + site.startPages[0].substring(site.startPages[0].length - 47) 
            : site.startPages[0])
        : '(none)';
      
      console.log(`${domain.padEnd(domainWidth)} | ${count} | ${firstUrl}`);
    });
    
    // Display summary statistics
    const totalStartPages = sitesWithStartPages.reduce((sum, site) => sum + site.startPagesCount, 0);
    const sitesWithPages = sitesWithStartPages.filter(site => site.startPagesCount > 0).length;
    const sitesWithoutPages = sitesWithStartPages.filter(site => site.startPagesCount === 0).length;
    
    console.log(`\n=== Summary ===`);
    console.log(`Total sites: ${allSites.length}`);
    console.log(`Sites with startPages: ${sitesWithPages}`);
    console.log(`Sites without startPages: ${sitesWithoutPages}`);
    console.log(`Total startPages: ${totalStartPages}`);
    console.log(`Average per site: ${(totalStartPages / allSites.length).toFixed(2)}`)
    
  } catch (error) {
    log.error('Error loading sites:', error);
    process.exit(1);
  }
}

main();