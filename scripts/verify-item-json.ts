#!/usr/bin/env node
import fs from 'fs';
import readline from 'readline';
import { getJsonScraper } from '../src/scrapers-json/index.js';
import { logger } from '../src/utils/logger.js';

const log = logger.createContext('verify-item-json');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: npm run verify:item:json <JSONL_FILE> -- --limit=<N> --domain=<DOMAIN>');
    console.error('  --limit=<N>      Process N items (default: 1, 0 = all items)');
    console.error('  --domain=<NAME>  Override domain detection (e.g., --domain=diesel.com)');
    console.error('\nIMPORTANT: Use -- before options when using npm run');
    process.exit(1);
  }

  const jsonlFile = args[0];
  let limit = 1; // Default: process only first item
  let overrideDomain: string | undefined;

  // Debug: log all arguments
  log.debug(`All arguments: ${JSON.stringify(args)}`);

  // Parse parameters - ONLY handle --param=value format
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg.startsWith('--limit=')) {
      limit = parseInt(arg.split('=')[1], 10);
      if (isNaN(limit) || limit < 0) {
        console.error('Invalid limit value. Must be a non-negative integer.');
        process.exit(1);
      }
      log.normal(`Using limit: ${limit}`);
    }
    
    if (arg.startsWith('--domain=')) {
      overrideDomain = arg.split('=')[1];
      log.normal(`Using override domain: ${overrideDomain}`);
    }
  }

  if (!fs.existsSync(jsonlFile)) {
    console.error(`File not found: ${jsonlFile}`);
    process.exit(1);
  }

  const fileStream = fs.createReadStream(jsonlFile);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let lineNumber = 0;
  let itemsProcessed = 0;
  const results = [];

  for await (const line of rl) {
    lineNumber++;
    
    // Skip empty lines
    if (!line.trim()) continue;

    // Check if we've reached the limit (0 means no limit)
    if (limit > 0 && itemsProcessed >= limit) {
      log.normal(`Reached limit of ${limit} items, stopping...`);
      break;
    }

    try {
      const json = JSON.parse(line);
      
      // Extract domain - use override if provided, otherwise detect from URLs
      let domain = overrideDomain;
      
      if (!domain) {
        // Try to find domain from various URL fields
        const urlFields = [
          json.url,
          json.productUrl,
          json.link,
          json.canonicalUrl,
          json.selectedProductUrl,
          json.data?.product?.selectedProductUrl,
          json.data?.originalUri,
          json.originalUri
        ];
        
        for (const urlField of urlFields) {
          if (urlField && typeof urlField === 'string') {
            try {
              const url = new URL(urlField.startsWith('http') ? urlField : `https://${urlField}`);
              domain = url.hostname.replace('www.', '').replace('shop.', '');
              log.debug(`Detected domain from URL: ${domain}`);
              break;
            } catch (e) {
              // Invalid URL, try next
            }
          }
        }
      }
      
      if (!domain) {
        log.error(`Line ${lineNumber}: Could not detect domain from JSON (use --domain to specify)`);
        // Still check if we should stop reading more lines
        if (limit === 1 && itemsProcessed === 0) {
          log.error('Stopping after first line (no valid item found)');
          break;
        }
        continue;
      }

      const scraper = getJsonScraper(domain);
      if (!scraper) {
        log.error(`Line ${lineNumber}: No scraper found for domain: ${domain}`);
        continue;
      }

      const item = scraper.scrapeItem(json, { uploadToS3: false });
      results.push(item);
      itemsProcessed++;
      
      log.normal(`Processed item ${itemsProcessed} from line ${lineNumber}: ${item.name}`);
      
    } catch (error) {
      log.error(`Line ${lineNumber}: Failed to parse or process - ${error}`);
    }
  }

  // Output results as JSON
  console.log('\n=== Results ===');
  console.log(`Processed ${itemsProcessed} items from ${lineNumber} lines\n`);
  
  results.forEach((item) => {
    console.log(JSON.stringify(item, null, 2));
  });
}

main().catch(error => {
  log.error('Fatal error:', error);
  process.exit(1);
});