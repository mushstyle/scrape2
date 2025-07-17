/**
 * Mock example: Robust pagination with simulated failures
 * 
 * This example shows the core robust pagination features with mock data:
 * - Multiple sites paginating independently
 * - Failure handling and retries with simulated network errors
 * - Proxy blocklist in action
 * - Partial run commits
 * 
 * Usage:
 * npm run example:pagination:mock
 */

import { SiteManager } from '../src/services/site-manager.js';
import { logger } from '../src/utils/logger.js';

const log = logger.createContext('robust-pagination-simple');

// Mock pagination that sometimes fails
async function mockPaginate(
  url: string, 
  failureRate: number = 0.3
): Promise<string[]> {
  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Random failure
  if (Math.random() < failureRate) {
    throw new Error(`Network timeout for ${url}`);
  }
  
  // Return mock URLs
  const domain = new URL(url).hostname;
  const pageNum = url.match(/page(\d+)/)?.[1] || '1';
  
  return [
    `https://${domain}/item-${pageNum}-1`,
    `https://${domain}/item-${pageNum}-2`,
    `https://${domain}/item-${pageNum}-3`,
  ];
}

async function main() {
  // Initialize managers
  const siteManager = new SiteManager();
  
  // Add test sites manually (instead of loading from ETL API)
  siteManager.addSite('site-a.com', {
    domain: 'site-a.com',
    scraper: 'test-scraper',
    startPages: [
      'https://site-a.com/page1',
      'https://site-a.com/page2',
    ],
    scraping: {
      browser: {
        ignoreHttpsErrors: true,
        headers: {}
      }
    },
    proxy: {
      strategy: 'datacenter',
      geo: 'US',
      cooldownMinutes: 5, // Short cooldown for demo
      failureThreshold: 2,
      sessionLimit: 2
    }
  });
  
  siteManager.addSite('site-b.com', {
    domain: 'site-b.com',
    scraper: 'test-scraper',
    startPages: [
      'https://site-b.com/page1',
      'https://site-b.com/page2',
      'https://site-b.com/page3',
    ],
    scraping: {
      browser: {
        ignoreHttpsErrors: true,
        headers: {}
      }
    },
    proxy: {
      strategy: 'datacenter',
      geo: 'US',
      cooldownMinutes: 5,
      failureThreshold: 2,
      sessionLimit: 3
    }
  });
  
  const sites = ['site-a.com', 'site-b.com'];
  
  log.normal('Starting robust pagination demo...\n');
  
  // Process sites concurrently
  const sitePromises = sites.map(async (site) => {
    log.normal(`📋 Starting pagination for ${site}`);
    
    const siteConfig = siteManager.getSite(site);
    if (!siteConfig) return;
    
    // Start tracking pagination for this site
    await siteManager.startPagination(site, siteConfig.config.startPages);
    
    // Process each start page
    for (const startPage of siteConfig.config.startPages) {
      let attempts = 0;
      const maxAttempts = 3;
      let success = false;
      
      while (attempts < maxAttempts && !success) {
        attempts++;
        
        try {
          log.normal(`  ↻ Paginating ${startPage} (attempt ${attempts}/${maxAttempts})...`);
          
          // Simulate pagination with possible failures
          const urls = await mockPaginate(startPage, attempts === 1 ? 0.7 : 0.2); // High failure rate on first attempt
          
          // Update pagination state with success
          siteManager.updatePaginationState(startPage, {
            collectedUrls: urls,
            completed: true
          });
          
          log.normal(`    ✓ Collected ${urls.length} URLs`);
          success = true;
          
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          log.error(`    ✗ Failed: ${errorMsg}`);
          
          // Track failure
          siteManager.updatePaginationState(startPage, {
            failureCount: attempts,
            failureHistory: [{
              timestamp: new Date(),
              proxy: `datacenter-proxy-${attempts}`,
              error: errorMsg
            }]
          });
          
          // Simulate adding proxy to blocklist
          if (errorMsg.includes('Network')) {
            await siteManager.addProxyToBlocklist(site, `datacenter-proxy-${attempts}`, errorMsg);
            log.debug(`    🚫 Added datacenter-proxy-${attempts} to blocklist`);
          }
          
          if (attempts >= maxAttempts) {
            // Mark as completed with no URLs (will prevent commit)
            siteManager.updatePaginationState(startPage, {
              collectedUrls: [],
              completed: true
            });
          }
        }
      }
    }
    
    // Try to commit the partial run
    try {
      const run = await siteManager.commitPartialRun(site);
      log.normal(`✅ ${site}: Successfully created run with ${run.items.length} URLs\n`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      log.error(`❌ ${site}: Failed to commit - ${errorMsg}\n`);
    }
    
    // Show blocked proxies
    const blockedProxies = await siteManager.getBlockedProxies(site);
    if (blockedProxies.length > 0) {
      log.normal(`🚫 ${site} blocked proxies: ${blockedProxies.join(', ')}`);
    }
  });
  
  // Wait for all sites to complete
  await Promise.all(sitePromises);
  
  // Final status
  log.normal('\n========== FINAL STATUS ==========');
  
  // Check for uncommitted partial runs
  const uncommitted = siteManager.getSitesWithPartialRuns();
  if (uncommitted.length > 0) {
    log.error(`⚠️  Sites with uncommitted runs: ${uncommitted.join(', ')}`);
  } else {
    log.normal('✓ All partial runs processed');
  }
  
  // Show final blocked proxies with cooldown info
  log.normal('\n🚫 Blocked Proxies (will auto-clear after cooldown):');
  for (const site of sites) {
    const blocked = await siteManager.getBlockedProxies(site);
    if (blocked.length > 0) {
      log.normal(`  ${site}: ${blocked.join(', ')} (5 min cooldown)`);
    }
  }
}

// Run the example
main().catch(error => {
  log.error('Example failed:', error);
  process.exit(1);
});