#!/usr/bin/env tsx --env-file=.env

/**
 * CLI wrapper for VerifyPaginateEngine (using distributor)
 * Usage: npm run verify:paginate <SITE>
 */

import { VerifyPaginateEngine } from '../src/engines/verify-paginate-engine.js';
import { logger } from '../src/utils/logger.js';
import { installGlobalErrorHandlers } from '../src/utils/error-handlers.js';

// Install global error handlers to prevent crashes from browser disconnections
installGlobalErrorHandlers();

const log = logger.createContext('verify-paginate');

async function main() {
  const args = process.argv.slice(2);
  const input = args[0];
  
  // Parse optional flags
  const useSingleSession = args.includes('--single');
  const localHeadless = args.includes('--local-headless');
  const localHeaded = args.includes('--local-headed');
  
  // Parse maxPages if provided
  let maxPages: number | undefined;
  const maxPagesArg = args.find(arg => arg.startsWith('--max-pages='));
  if (maxPagesArg) {
    maxPages = parseInt(maxPagesArg.replace('--max-pages=', ''), 10);
  }
  
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
  
  if (!input) {
    console.log('Usage: npm run verify:paginate <SITE|URL> [options]');
    console.log('Options:');
    console.log('  --single           Only scrapes one start page');
    console.log('  --max-pages=N      Limit to N pages');
    console.log('  --local-headless   Use local browser in headless mode');
    console.log('  --local-headed     Use local browser in headed mode');
    console.log('  --session-timeout=N Session timeout in seconds (browserbase only)');
    console.log('Examples:');
    console.log('  npm run verify:paginate amgbrand.com');
    console.log('  npm run verify:paginate https://musthave.ua/en/catalog/obuv?page=1');
    console.log('  npm run verify:paginate amgbrand.com --single');
    console.log('  npm run verify:paginate amgbrand.com --max-pages=3');
    console.log('  npm run verify:paginate amgbrand.com --local-headed');
    process.exit(1);
  }
  
  // Determine if input is a URL or domain
  const isUrl = input.startsWith('http://') || input.startsWith('https://');
  const domain = isUrl ? new URL(input).hostname : input;
  const specificUrl = isUrl ? input : undefined;
  
  try {
    const engine = new VerifyPaginateEngine({ localHeadless, localHeaded });
    const result = await engine.verify({ 
      domain,
      specificUrl,
      maxPages,  // NO DEFAULT LIMIT!
      useSingleSession,
      localHeadless,
      localHeaded,
      sessionTimeout
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