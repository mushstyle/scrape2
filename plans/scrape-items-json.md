# Plan: Implement `npm run scrape items:json`

## Overview
Create a command to process JSON/JSONL files containing pre-fetched product data, using JSON scrapers to transform them into our standard item format and save to the pending items API.

## Command Syntax
```bash
npm run scrape items:json -- --dir=<DIR> [options]
```

## Parameters

### Required
- `--dir=<DIR>` - Directory containing JSON/JSONL files to process

### Optional
- `--sites=<site1,site2>` - Only process files for these sites (comma-separated)
- `--batch-size=<N>` - Items to batch before saving to API (default: 100)
- `--no-s3` - Disable S3 image upload (enabled by default)

## Implementation Steps

1. **Create CLI script** (`scripts/scrape-items-json.ts`)
   - Parse command-line arguments
   - Validate directory exists
   - Find all `.json` and `.jsonl` files in directory

2. **Process each file**:
   - Detect domain from filename (e.g., `shop.diesel.com.jsonl` → `shop.diesel.com`)
   - Skip if `--sites` provided and domain not in list
   - Get site config from API to verify it's type: 'json'
   - Load appropriate JSON scraper from `/src/scrapers-json/`

3. **Process items**:
   - For JSONL: Process line by line
   - For JSON: Process as single object or array
   - Transform each item using the JSON scraper
   - Batch items according to `--batch-size`
   - Save batches to pending items API

4. **Error handling**:
   - Skip malformed JSON lines with warning
   - Continue processing other files if one fails
   - Report summary at end

## Success Criteria
- Can process directory of JSON/JSONL files
- Correctly identifies and uses JSON scrapers
- Saves items to pending items API in batches
- Uploads images to S3 by default
- Clear progress reporting

## Example Usage
```bash
# Process all files in a directory
npm run scrape items:json -- --dir=/data/exports

# Process only specific sites
npm run scrape items:json -- --dir=/data/exports --sites=shop.diesel.com,cos.com

# Process without S3 upload
npm run scrape items:json -- --dir=/data/exports --no-s3
```