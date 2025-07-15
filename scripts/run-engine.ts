#!/usr/bin/env tsx
/**
 * Script to run the scraping engine
 * Usage: 
 *   npm run scrape:urls -- [options]    # Run paginate loop
 *   npm run scrape:items -- [options]   # Run item loop
 */

import { Engine } from '../src/lib/engine.js';
import { logger } from '../src/lib/logger.js';

const log = logger.createContext('run-engine');

interface RunOptions {
  mode: 'urls' | 'items';
  provider?: 'browserbase' | 'local';
  since?: string;
  instanceLimit?: number;
}

function parseArgs(): RunOptions {
  const args = process.argv.slice(2);
  
  // First argument determines the mode
  const mode = process.env.SCRAPE_MODE as 'urls' | 'items';
  if (!mode || (mode !== 'urls' && mode !== 'items')) {
    throw new Error('Invalid mode. Use npm run scrape:urls or npm run scrape:items');
  }
  
  const options: RunOptions = { mode };
  
  // Parse remaining arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' && i + 1 < args.length) {
      const provider = args[i + 1];
      if (provider === 'browserbase' || provider === 'local') {
        options.provider = provider;
      } else {
        throw new Error(`Invalid provider: ${provider}. Use 'browserbase' or 'local'`);
      }
      i++;
    } else if (args[i] === '--since' && i + 1 < args.length) {
      options.since = args[i + 1];
      i++;
    } else if (args[i] === '--instance-limit' && i + 1 < args.length) {
      options.instanceLimit = parseInt(args[i + 1], 10);
      if (isNaN(options.instanceLimit) || options.instanceLimit < 1) {
        throw new Error('Instance limit must be a positive number');
      }
      i++;
    }
  }
  
  return options;
}

async function main() {
  try {
    const options = parseArgs();
    
    log.normal(`Starting engine in ${options.mode} mode...`);
    
    const engine = new Engine({
      provider: options.provider,
      since: options.since,
      instanceLimit: options.instanceLimit
    });
    
    if (options.mode === 'urls') {
      await engine.paginateLoop();
    } else {
      await engine.itemLoop();
    }
    
    await engine.cleanup();
    
  } catch (error) {
    log.error('Engine script failed:', error);
    process.exit(1);
  }
}

main();