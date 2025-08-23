#!/usr/bin/env node
import fs from 'fs';
import readline from 'readline';
import { getJsonScraper } from '../src/scrapers-json/index.js';
import logger from '../src/utils/logger.js';

const log = logger.createContext('verify-item-json');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: npm run verify:item:json <JSONL_FILE> [--limit <N>]');
    console.error('  --limit <N>  Process N items (default: 1, 0 = all items)');
    process.exit(1);
  }

  const jsonlFile = args[0];
  let limit = 1; // Default: process only first item

  // Parse limit parameter
  const limitIndex = args.indexOf('--limit');
  if (limitIndex !== -1 && args[limitIndex + 1]) {
    limit = parseInt(args[limitIndex + 1], 10);
    if (isNaN(limit) || limit < 0) {
      console.error('Invalid limit value. Must be a non-negative integer.');
      process.exit(1);
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
    if (limit > 0 && itemsProcessed >= limit) break;

    try {
      const json = JSON.parse(line);
      
      // Extract domain from the JSON object (assumes it has a domain field)
      const domain = json.domain || json.site || json.website;
      if (!domain) {
        log.error(`Line ${lineNumber}: No domain field found in JSON`);
        continue;
      }

      const scraper = getJsonScraper(domain);
      if (!scraper) {
        log.error(`Line ${lineNumber}: No scraper found for domain: ${domain}`);
        continue;
      }

      const item = scraper.scrapeItem(json);
      results.push(item);
      itemsProcessed++;
      
      log.normal(`Processed item ${itemsProcessed} from line ${lineNumber}: ${item.name}`);
      
    } catch (error) {
      log.error(`Line ${lineNumber}: Failed to parse or process - ${error}`);
    }
  }

  // Output results
  console.log('\n=== Results ===');
  console.log(`Processed ${itemsProcessed} items from ${lineNumber} lines`);
  console.log('\nItems:');
  results.forEach((item, index) => {
    console.log(`\n[${index + 1}] ${item.name}`);
    console.log(`  ID: ${item.id}`);
    console.log(`  URL: ${item.url}`);
    console.log(`  Price: ${item.currency} ${item.currentPrice}`);
    console.log(`  In Stock: ${item.inStock}`);
  });
}

main().catch(error => {
  log.error('Fatal error:', error);
  process.exit(1);
});