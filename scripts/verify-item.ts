#!/usr/bin/env tsx --env-file=.env

/**
 * CLI wrapper for VerifyItemEngine
 * Usage: npm run verify:item <URL>
 */

import { VerifyItemEngine } from '../src/engines/verify-item-engine.js';
import { logger } from '../src/utils/logger.js';
import { installGlobalErrorHandlers } from '../src/utils/error-handlers.js';

// Install global error handlers to prevent crashes from browser disconnections
installGlobalErrorHandlers();

const log = logger.createContext('verify-item');

async function main() {
  const args = process.argv.slice(2);
  const url = args.find(arg => !arg.startsWith('--'));
  
  // Parse optional flags
  const localHeadless = args.includes('--local-headless');
  const localHeaded = args.includes('--local-headed');
  const noProxy = args.includes('--no-proxy');
  
  // Parse session timeout
  let sessionTimeout: number | undefined;
  const timeoutIndex = args.findIndex(arg => arg === '--session-timeout' || arg.startsWith('--session-timeout='));
  if (timeoutIndex !== -1) {
    const arg = args[timeoutIndex];
    if (arg.startsWith('--session-timeout=')) {
      sessionTimeout = parseInt(arg.replace('--session-timeout=', ''), 10);
    } else if (args[timeoutIndex + 1]) {
      sessionTimeout = parseInt(args[timeoutIndex + 1], 10);
    }
  }
  
  if (!url) {
    console.log('Usage: npm run verify:item <URL> [options]');
    console.log('Options:');
    console.log('  --local-headless   Use local browser in headless mode');
    console.log('  --local-headed     Use local browser in headed mode');
    console.log('  --session-timeout=N Session timeout in seconds (browserbase only)');
    console.log('  --no-proxy         Disable proxy usage (direct connection)');
    console.log('Example: npm run verify:item https://amgbrand.com/products/some-product');
    console.log('Example: npm run verify:item https://amgbrand.com/products/some-product --local-headed');
    process.exit(1);
  }
  
  try {
    const engine = new VerifyItemEngine({ localHeadless, localHeaded });
    const result = await engine.verify({ url, localHeadless, localHeaded, sessionTimeout, noProxy });
    
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