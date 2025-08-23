# JSON Scrapers Implementation Plan

## Overview
Add JSON scrapers that process JSON data directly. These scrapers will accept JSON objects as input and transform them into Item arrays.

## Implementation

### 1. Create Basic Structure
```
src/
├── scrapers-json/     
│   ├── index.ts       # Exports all JSON scrapers
│   ├── types.ts       # JsonScraper interface
│   └── example.ts     # Example JSON scraper
```

### 2. Define Types
```typescript
// src/scrapers-json/types.ts
import type { Item } from '../types/item.js';

export interface JsonScraper {
  domain: string;
  scrapeItem(json: unknown): Item;
}
```

### 3. Create Example Scraper
```typescript
// src/scrapers-json/example.ts
import type { JsonScraper } from './types.js';

const scraper: JsonScraper = {
  domain: 'example.com',
  scrapeItem(json: unknown): Item {
    // Transform single JSON object to Item
  }
};

export default scraper;
```

### 4. Add CLI Command
```bash
# Verify JSONL file import
npm run verify:item:json <JSONL_FILE> [--limit <N>]

# Examples
npm run verify:item:json products.jsonl              # Default: first item only
npm run verify:item:json products.jsonl --limit 10   # Process first 10 items
npm run verify:item:json products.jsonl --limit 0    # Process all items (no limit)
```

The command will:
1. Read the JSONL file line by line
2. Parse each line as a JSON object
3. Find the matching JSON scraper by domain
4. Parse each JSON object into an Item using scrapeItem()
5. Stop after processing N items (default: 1, 0 = no limit)
6. Output or save the results

## Success Criteria
- [ ] `/src/scrapers-json/` directory created with types
- [ ] At least one example JSON scraper
- [ ] CLI command that reads JSON and outputs Items