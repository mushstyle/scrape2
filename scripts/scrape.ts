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

const log = logger.createContext('scrape-cli');

interface PaginateOptions {
  sites?: string[];
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

function parseArgs(args: string[]): { command: string; options: any } {
  const command = args[0];
  const options: any = {};
  
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--sites' && i + 1 < args.length) {
      options.sites = args[i + 1].split(',').map(s => s.trim());
      i++;
    } else if (arg === '--instance-limit' && i + 1 < args.length) {
      options.instanceLimit = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--max-pages' && i + 1 < args.length) {
      options.maxPages = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--item-limit' && i + 1 < args.length) {
      options.itemLimit = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--disable-cache') {
      options.disableCache = true;
    } else if (arg === '--cache-size-mb' && i + 1 < args.length) {
      options.cacheSizeMB = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--cache-ttl-seconds' && i + 1 < args.length) {
      options.cacheTTLSeconds = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--no-save') {
      options.noSave = true;
    } else if (arg === '--local-headless') {
      options.localHeadless = true;
    } else if (arg === '--local-headed') {
      options.localHeaded = true;
    } else if (arg === '--session-timeout' && i + 1 < args.length) {
      options.sessionTimeout = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--max-retries' && i + 1 < args.length) {
      options.maxRetries = parseInt(args[i + 1], 10);
      i++;
    }
  }
  
  return { command, options };
}

async function runPaginate(options: PaginateOptions) {
  const siteManager = new SiteManager();
  const sessionManager = new SessionManager();
  
  await siteManager.loadSites();
  
  const engine = new PaginateEngine(siteManager, sessionManager);
  const result = await engine.paginate(options);
  
  // Display results
  console.log(`\nProcessed ${result.sitesProcessed} sites`);
  console.log(`Collected ${result.totalUrls} URLs`);
  
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
  const sessionManager = new SessionManager();
  
  await siteManager.loadSites();
  
  const engine = new ScrapeItemEngine(siteManager, sessionManager);
  const result = await engine.scrapeItems(options);
  
  // Display results
  console.log(`\nScraped ${result.itemsScraped} items`);
  
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
      console.log('  --sites=site1,site2       Sites to process (optional)');
      console.log('  --instance-limit=N        Max concurrent sessions (default: 10)');
      console.log('  --max-pages=N             Max pages to paginate (default: 5)');
      console.log('  --item-limit=N            Max items per site (default: 100)');
      console.log('  --disable-cache           Disable request caching');
      console.log('  --cache-size-mb=N         Cache size in MB (default: 100)');
      console.log('  --cache-ttl-seconds=N     Cache TTL in seconds (default: 300)');
      console.log('  --no-save                 Skip saving to database');
      console.log('  --local-headless          Use local browser in headless mode');
      console.log('  --local-headed            Use local browser in headed mode');
      console.log('  --session-timeout=N       Session timeout in seconds');
      console.log('  --max-retries=N           Max retries for network errors (default: 2)');
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