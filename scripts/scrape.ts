#!/usr/bin/env tsx --env-file=.env

/**
 * CLI script for scrape commands
 * Usage: 
 *   npm run scrape paginate [options]    # Run paginate engine
 *   npm run scrape items [options]       # Run scrape items engine
 *   npm run scrape verify paginate [options]  # Run verify paginate  
 *   npm run scrape verify item [options]      # Run verify item
 */

import { PaginateEngine } from '../src/engines/paginate-engine.js';
import { ScrapeItemEngine } from '../src/engines/scrape-item-engine.js';
import { SiteManager } from '../src/services/site-manager.js';
import { SessionManager } from '../src/services/session-manager.js';
import { logger } from '../src/utils/logger.js';
import { formatDate } from '../src/utils/time-parser.js';
import { parseArgs } from '../src/utils/cli-args.js';
import { installGlobalErrorHandlers } from '../src/utils/error-handlers.js';

// Install global error handlers to prevent crashes from browser disconnections
installGlobalErrorHandlers();

const log = logger.createContext('scrape-cli');

interface PaginateOptions {
  sites?: string[];
  exclude?: string[];
  since?: Date;
  force?: boolean;
  instanceLimit?: number;
  maxPages?: number;
  disableCache?: boolean;
  cacheSizeMB?: number;
  cacheTTLSeconds?: number;
  noSave?: boolean;
  localHeadless?: boolean;
  localHeaded?: boolean;
  sessionTimeout?: number;
  maxRetries?: number;
}

interface ItemsOptions {
  sites?: string[];
  exclude?: string[];
  since?: Date;
  instanceLimit?: number;
  itemLimit?: number;
  disableCache?: boolean;
  cacheSizeMB?: number;
  cacheTTLSeconds?: number;
  noSave?: boolean;
  localHeadless?: boolean;
  localHeaded?: boolean;
  sessionTimeout?: number;
  maxRetries?: number;
}


async function runPaginate(options: PaginateOptions) {
  const siteManager = new SiteManager();
  const sessionManager = new SessionManager({
    sessionLimit: options.instanceLimit || 10
  });
  
  await siteManager.loadSites();
  
  // Default to 2d if no since provided and not forcing
  if (!options.since && !options.force) {
    const { parseTimeDuration } = await import('../src/utils/time-parser.js');
    options.since = parseTimeDuration('2d');
    log.normal('Using default --since value of 2d (use --force to override)');
  }
  
  const engine = new PaginateEngine(siteManager, sessionManager);
  const result = await engine.paginate(options);
  
  // Display results
  console.log(`\nProcessed ${result.sitesProcessed} sites`);
  console.log(`Collected ${result.totalUrls} URLs`);
  
  if (options.since) {
    console.log(`Since: ${formatDate(options.since)}`);
  }
  
  if (!options.noSave) {
    console.log(`Saved to database`);
  }
  
  if (result.cacheStats) {
    console.log(`Cache hit rate: ${result.cacheStats.hitRate.toFixed(1)}%`);
  }
  
  if (result.errors.size > 0) {
    console.log(`\nErrors:`);
    for (const [site, error] of result.errors) {
      console.log(`  ${site}: ${error}`);
    }
  }
  
  return result.success;
}

async function runItems(options: ItemsOptions) {
  const siteManager = new SiteManager();
  const sessionManager = new SessionManager({
    sessionLimit: options.instanceLimit || 10
  });
  
  await siteManager.loadSites();
  
  const engine = new ScrapeItemEngine(siteManager, sessionManager);
  const result = await engine.scrapeItems(options);
  
  // Display results
  console.log(`\nScraped ${result.itemsScraped} items`);
  
  if (options.since) {
    console.log(`Since: ${formatDate(options.since)}`);
  }
  
  for (const [site, items] of result.itemsBySite) {
    console.log(`  ${site}: ${items.length} items`);
  }
  
  if (!options.noSave) {
    console.log(`Saved to ETL API`);
  }
  
  if (result.errors.size > 0) {
    console.log(`\nFailed: ${result.errors.size} items`);
    let errorCount = 0;
    for (const [url, error] of result.errors) {
      if (errorCount < 5) {
        console.log(`  ${url}: ${error}`);
        errorCount++;
      }
    }
    if (result.errors.size > 5) {
      console.log(`  ... and ${result.errors.size - 5} more`);
    }
  }
  
  return result.success;
}

async function main() {
  try {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
      console.log('Usage:');
      console.log('  npm run scrape paginate [options]');
      console.log('  npm run scrape items [options]');
      console.log('  npm run scrape verify paginate <site>');
      console.log('  npm run scrape verify item <url>');
      console.log('');
      console.log('Options:');
      console.log('  --sites site1,site2       Sites to process (optional)');
      console.log('  --exclude site1,site2     Sites to exclude (takes precedence over --sites)');
      console.log('  --since 1d                Only process sites without runs since (default: 2d for paginate)');
      console.log('  --force                   Force pagination even if sites have recent runs (ignores --since)');
      console.log('  --instance-limit N        Max concurrent sessions (default: 10)');
      console.log('  --max-pages N             Max pages to paginate (default: 5)');
      console.log('  --item-limit N            Max items per site (default: 100)');
      console.log('  --disable-cache           Disable request caching');
      console.log('  --cache-size-mb N         Cache size in MB (default: 100)');
      console.log('  --cache-ttl-seconds N     Cache TTL in seconds (default: 300)');
      console.log('  --no-save                 Skip saving to database');
      console.log('  --local-headless          Use local browser in headless mode');
      console.log('  --local-headed            Use local browser in headed mode');
      console.log('  --session-timeout N       Session timeout in seconds');
      console.log('  --max-retries N           Max retries for network errors (default: 2)');
      console.log('  --retry-failed            Include previously failed items in scraping');
      process.exit(1);
    }
    
    const { command, options } = parseArgs(args);
    
    // Handle verify commands separately
    if (command === 'verify' && args[1] === 'paginate') {
      // Run verify paginate script
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      const site = args[2];
      if (!site) {
        console.log('Usage: npm run scrape verify paginate <site>');
        process.exit(1);
      }
      
      const { stdout, stderr } = await execAsync(`npm run verify:paginate ${site}`);
      console.log(stdout);
      if (stderr) console.error(stderr);
      process.exit(0);
    }
    
    if (command === 'verify' && args[1] === 'item') {
      // Run verify item script
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      const url = args[2];
      if (!url) {
        console.log('Usage: npm run scrape verify item <url>');
        process.exit(1);
      }
      
      const { stdout, stderr } = await execAsync(`npm run verify:item ${url}`);
      console.log(stdout);
      if (stderr) console.error(stderr);
      process.exit(0);
    }
    
    // Handle main commands
    let success = false;
    
    switch (command) {
      case 'paginate':
        success = await runPaginate(options);
        break;
        
      case 'items':
        success = await runItems(options);
        break;
        
      default:
        console.error(`Unknown command: ${command}`);
        console.log('Use "npm run scrape" to see available commands');
        process.exit(1);
    }
    
    process.exit(success ? 0 : 1);
    
  } catch (error) {
    log.error('Scrape command failed:', error);
    process.exit(1);
  }
}

main();