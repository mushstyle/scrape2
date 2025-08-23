# JSON Scrapers Rules

## Overview
JSON scrapers process raw JSON data (typically from API responses) instead of HTML. They transform JSON objects into standardized `Item` objects.

## Directory Structure
```
src/scrapers-json/
├── types.ts        # JsonScraper interface definition
├── index.ts        # Registry and exports
├── example.ts      # Basic example scraper
└── [domain].ts     # One file per domain (e.g., diesel.com.ts)
```

## Creating a JSON Scraper

### 1. File Location
- Create a new file in `/src/scrapers-json/` named after the domain
- Use the exact domain name: `diesel.com.ts`, not `diesel.ts`
- Remove `www.` or `shop.` prefixes from the filename

### 2. Scraper Structure
```typescript
import type { JsonScraper } from './types.js';
import type { Item, Image, Size } from '../types/item.js';

const scraper: JsonScraper = {
  domain: 'example.com',
  
  scrapeItem(json: unknown, uploadToS3: boolean = true): Item {
    const data = json as any;
    
    // Extract and transform data...
    
    return {
      id: // required
      name: // required
      url: // required
      // ... other Item fields
    };
  }
};

export default scraper;
```

### 3. Register the Scraper
Add your scraper to `/src/scrapers-json/index.ts`:
```typescript
import diesel from './diesel.com.js';

const scrapers: Record<string, JsonScraper> = {
  'diesel.com': diesel,
  // ... other scrapers
};
```

## Key Implementation Guidelines

### Finding the Product URL
The product URL is critical for identifying items. Look for it in these common locations:
```typescript
// Priority order for URL detection:
1. data.product.selectedProductUrl
2. data.url or json.url
3. data.product.url
4. data.canonicalUrl
5. data.link or json.link

// Always build full URLs:
const baseUrl = 'https://shop.example.com';
const productUrl = data.product.selectedProductUrl 
  ? baseUrl + data.product.selectedProductUrl
  : data.url || '';
```

### Extracting Product Data
```typescript
// Always check if nested properties exist:
const product = data?.data?.product;
if (!product) {
  throw new Error('Invalid JSON structure - missing product data');
}

// Extract price with fallbacks:
const currentPrice = product.price?.sales?.value || 0;
const originalPrice = product.price?.list?.value || currentPrice;

// Handle images array:
const images: Image[] = [];
if (product.images?.large) {
  product.images.large.forEach((img: any) => {
    if (img.absURL || img.url) {
      images.push({
        url: img.absURL || img.url,
        alt: img.alt || product.productName
      });
    }
  });
}

// Extract sizes from variation attributes:
const sizes: Size[] = [];
const sizeAttr = product.variationAttributes?.find((attr: any) => 
  attr.attributeId === 'size' || attr.id === 'size'
);
if (sizeAttr?.values) {
  sizeAttr.values.forEach((size: any) => {
    sizes.push({
      name: size.displayValue || size.value,
      inStock: size.selectable !== false,
      price: currentPrice
    });
  });
}
```

### Stock Status
```typescript
// Check multiple fields for availability:
const inStock = product.available !== false 
  && product.availability?.isStock !== false
  && product.inStock !== false;
```

### S3 Upload Parameter
All JSON scrapers must accept an optional `uploadToS3` parameter (defaults to `true`):
```typescript
scrapeItem(json: unknown, uploadToS3: boolean = true): Item {
  // Process the item...
  
  if (uploadToS3) {
    // Upload logic will be handled by the caller
    // Just ensure the Item has all required fields
  }
  
  return item;
}
```

## Testing Your Scraper

### 1. Create a Test JSONL File
Create a file with one JSON object per line, each with a `domain` field:
```jsonl
{"domain":"example.com","url":"https://example.com/product1","data":{...}}
{"domain":"example.com","url":"https://example.com/product2","data":{...}}
```

### 2. Run the Verification Command
```bash
# Test first item only (default)
npm run verify:item:json test-file.jsonl

# Test specific number of items
npm run verify:item:json test-file.jsonl -- --limit=5

# Test all items
npm run verify:item:json test-file.jsonl -- --limit=0

# Override domain detection
npm run verify:item:json test-file.jsonl -- --domain=example.com
```

### 3. Domain Auto-Detection
The verify command automatically detects domains from URLs in the JSON:
- Looks for URL fields: `url`, `productUrl`, `data.originalUri`, etc.
- Strips `www.` and `shop.` prefixes
- Falls back to `--domain` parameter if detection fails

## Common Patterns

### Handling Nested Data
```typescript
// Safe navigation with optional chaining:
const category = data?.product?.category?.name || '';
const brand = data?.product?.brand || data?.brand || '';
```

### Building Metadata
```typescript
metadata: {
  productType: product.productType,
  masterID: product.masterID,
  gender: product.gender,
  rating: product.rating,
  // Include any domain-specific fields
}
```

### Error Handling
```typescript
scrapeItem(json: unknown, uploadToS3: boolean = true): Item {
  const data = json as any;
  
  if (!data?.product?.id) {
    throw new Error('Invalid JSON: missing product ID');
  }
  
  // Continue processing...
}
```

## Best Practices

1. **Type Safety**: Use `unknown` for the JSON parameter, then cast to `any` for flexibility
2. **Defensive Coding**: Always check for existence before accessing nested properties
3. **Fallbacks**: Provide sensible defaults for missing fields
4. **URL Handling**: Always build complete URLs, don't assume relative paths work
5. **Consistency**: Follow the same extraction patterns as HTML scrapers where possible
6. **Testing**: Test with actual JSON data from the target site
7. **Documentation**: Comment any unusual data transformations or site-specific quirks