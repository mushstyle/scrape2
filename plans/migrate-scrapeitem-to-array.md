# Migration Plan: scrapeItem Returns Array

## Overview
This plan updates `scrapeItem` to return an array of items (`Item[]`) instead of a single item (`Item`). Most scrapers will continue returning a single item wrapped in an array, but this change enables future scrapers to return multiple items when needed (e.g., variant products, bundles).

## Goals
- ✅ Simple and robust implementation
- ✅ No backwards compatibility needed
- ✅ Easy update for all scrapers
- ✅ Support future multi-item scenarios
- ✅ Validate Item[] arrays at engine boundaries

## Implementation Steps

### Step 1: Update Type Definition
**File:** `src/scrapers/types.ts`
```typescript
// Change from:
scrapeItem: (page: Page, options?: {...}) => Promise<Item>;
// To:
scrapeItem: (page: Page, options?: {...}) => Promise<Item[]>;
```

### Step 2: Update All Scrapers (37 files)
**Pattern for each scraper:**
```typescript
// Change from:
export async function scrapeItem(page: Page, options?: {...}): Promise<Item> {
  // ... scraping logic ...
  return Utils.formatItem(item);
}

// To:
export async function scrapeItem(page: Page, options?: {...}): Promise<Item[]> {
  // ... scraping logic ...
  return [Utils.formatItem(item)]; // Wrap in array
}
```

**Error handling:**
```typescript
// Instead of returning a fallback item on error:
return { sourceUrl, status: 'error', ... };

// Return empty array:
return [];
```

### Step 3: Update Engines (2 files)

#### `src/engines/scrape-item-engine.ts`
```typescript
// Line ~669 and ~774, change from:
const item = await scraper.scrapeItem(page);
const siteItems = itemsBySite.get(runInfo.domain) || [];
siteItems.push(item);

// To:
const items = await scraper.scrapeItem(page);
// TypeScript enforces the return type matches Promise<Item[]>
// No manual validation needed - trust the type system

// Set sourceUrl if missing on each item
items.forEach(item => {
  if (!item.sourceUrl) {
    item.sourceUrl = url;
  }
});

const siteItems = itemsBySite.get(runInfo.domain) || [];
siteItems.push(...items); // Spread array
```

#### `src/engines/verify-item-engine.ts`
```typescript
// Line ~115, change from:
const item = await scraper.scrapeItem(page);
if (!item) {
  throw new Error('Scraper returned null/undefined');
}

// To:
const items = await scraper.scrapeItem(page);
// TypeScript enforces the return type matches Promise<Item[]>

if (items.length === 0) {
  throw new Error('Scraper returned empty array');
}

// For verify, use first item
const item = items[0];

// Log if multiple items returned (for debugging)
if (items.length > 1) {
  log.normal(`Note: Scraper returned ${items.length} items, showing first item only`);
}

// Update field extraction:
const scraperFields = Object.keys(item).filter(key => item[key] !== null && item[key] !== undefined);
```

### Step 3a: Add Type Guards (Optional but Recommended)

If runtime validation is desired, create a type guard utility:

```typescript
// In src/utils/type-guards.ts (new file)
import type { Item } from '../types/item.js';

export function isValidItemArray(value: unknown): value is Item[] {
  return Array.isArray(value) && value.every(isValidItem);
}

export function isValidItem(value: unknown): value is Item {
  if (!value || typeof value !== 'object') return false;
  const item = value as any;
  
  // Check required fields exist and have correct types
  return typeof item.sourceUrl === 'string' &&
         typeof item.product_id === 'string' &&
         typeof item.title === 'string' &&
         (typeof item.price === 'number' || item.price === undefined) &&
         (typeof item.sale_price === 'number' || item.sale_price === undefined);
}

// Then in engines:
const items = await scraper.scrapeItem(page);
if (!isValidItemArray(items)) {
  throw new Error(`Scraper for ${domain} returned invalid data structure`);
}
```

### Step 4: Update Tests (3 files)

#### `src/engines/__tests__/scrape-item-engine.test.ts`
```typescript
// Update mock:
scrapeItem: vi.fn().mockResolvedValue([mockItem]) // Return array
```

#### `src/scrapers/scrapers.test.ts`
```typescript
// Update type checking expectations for scrapeItem return type
```

### Step 5: Update Documentation

#### `rules/scrapers.md` - Update scrapeItem documentation
```typescript
// Change from:
export async function scrapeItem(page: Page): Promise<Item>

// To:
export async function scrapeItem(page: Page): Promise<Item[]>
```

Update the description to mention:
- Function now returns an array of items
- Most scrapers will return a single item wrapped in an array: `[item]`
- Return empty array `[]` on errors instead of a fallback item
- Future scrapers may return multiple items for variants/bundles

## Execution Order
1. Update type definition first
2. Update all scrapers (bulk find/replace)
3. Update engines to handle arrays with validation
4. Update tests
5. Run all tests to verify
6. Update documentation

## Testing Strategy
1. Run unit tests: `npm test`
2. Verify single scraper: `npm run verify:item -- --url [test-url]`
3. Verify pagination: `npm run verify:paginate -- --sites [test-site]`
4. Run full scrape on test site: `npm run scrape item -- --sites amgbrand.com --item-limit 5`

## Risk Assessment
- **Low Risk**: Changes are mechanical and straightforward
- **Main Risk**: Missing a scraper file or forgetting to update error handling
- **Mitigation**: 
  - TypeScript will catch type mismatches at compile time
  - Runtime validation at engine boundaries will catch any issues

## Future Benefits
This change enables:
- Scrapers that return multiple variants as separate items
- Bundle/kit products that expand into multiple items
- More flexible scraping patterns