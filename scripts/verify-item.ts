#!/usr/bin/env tsx --env-file=.env

/**
 * CLI wrapper for VerifyItemEngine
 * Usage: npm run verify:item <URL>
 */

import { VerifyItemEngine } from '../src/engines/verify-item-engine.js';
import { logger } from '../src/utils/logger.js';

const log = logger.createContext('verify-item');

async function main() {
  const url = process.argv[2];
  
  if (!url) {
    console.log('Usage: npm run verify:item <URL>');
    console.log('Example: npm run verify:item https://amgbrand.com/products/some-product');
    process.exit(1);
  }
  
  try {
    const engine = new VerifyItemEngine();
    const result = await engine.verify({ url });
    
    // Display results
    log.normal('\n=== Verification Results ===');
    log.normal(`URL: ${result.url}`);
    log.normal(`Domain: ${result.domain}`);
    log.normal(`Success: ${result.success}`);
    log.normal(`Duration: ${(result.duration / 1000).toFixed(2)}s`);
    
    if (result.success && result.item) {
      log.normal(`\nScraped item (${result.scraperFields?.length || 0} fields):`);
      
      // Pretty print the entire item as JSON
      console.log(JSON.stringify(result.item, null, 2));
    }
    
    if (result.error) {
      log.error(`\nError: ${result.error}`);
    }
    
    // Exit with appropriate code
    process.exit(result.success ? 0 : 1);
    
  } catch (error) {
    log.error(`Fatal error: ${error.message}`);
    process.exit(1);
  }
}

main();