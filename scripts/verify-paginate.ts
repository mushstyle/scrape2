#!/usr/bin/env tsx --env-file=.env

/**
 * CLI wrapper for VerifyPaginateEngine (using distributor)
 * Usage: npm run verify:paginate <SITE>
 */

import { VerifyPaginateEngine } from '../src/engines/verify-paginate-engine.js';
import { logger } from '../src/utils/logger.js';

const log = logger.createContext('verify-paginate');

async function main() {
  const domain = process.argv[2];
  
  if (!domain) {
    console.log('Usage: npm run verify:paginate <SITE>');
    console.log('Example: npm run verify:paginate amgbrand.com');
    process.exit(1);
  }
  
  try {
    const engine = new VerifyPaginateEngine();
    const result = await engine.verify({ 
      domain,
      maxPages: 5 // Limit for demo
    });
    
    // Display results
    log.normal('\n=== Verification Results ===');
    log.normal(`Site: ${result.domain}`);
    log.normal(`Success: ${result.success}`);
    log.normal(`Start pages: ${result.startPagesCount}`);
    log.normal(`Total pages scraped: ${result.totalPagesScraped}`);
    log.normal(`Total unique URLs: ${result.totalUniqueUrls}`);
    log.normal(`Iterations: ${result.iterations}`);
    log.normal(`Duration: ${(result.duration / 1000).toFixed(2)}s`);
    
    if (result.errors.length > 0) {
      log.normal('\nErrors:');
      result.errors.forEach(error => log.error(`  - ${error}`));
    }
    
    // Exit with appropriate code
    process.exit(result.success ? 0 : 1);
    
  } catch (error) {
    log.error(`Fatal error: ${error.message}`);
    process.exit(1);
  }
}

main();