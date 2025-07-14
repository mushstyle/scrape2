# Example Creation Rules

## File Organization
- **Location**: All examples go in `examples/` directory
- **Naming**: Use kebab-case filenames (e.g., `start-pages.ts`, `session-cleanup.ts`)
- **Extension**: Use `.ts` for TypeScript examples, `.js` for JavaScript

## Package.json Scripts
- **Pattern**: `example:<name>` where `<name>` matches the filename without extension
- **Command**: `tsx --no-warnings --env-file=.env examples/<filename>`
- **Example**: For `examples/start-pages.ts` → `"example:start-pages": "tsx --no-warnings --env-file=.env examples/start-pages.ts"`

## Code Structure
- **Imports**: Use relative imports from `../src/` 
- **Logging**: Use `logger.createContext('example-name')` for consistent logging
- **Error Handling**: Always wrap main logic in try/catch
- **Cleanup**: Ensure proper cleanup of resources (sessions, etc.)

## Documentation
- **Comments**: Include brief description at top of file
- **Usage**: Add command line usage examples in comments
- **Parameters**: Document any CLI arguments or environment variables needed

## Examples Should Demonstrate
- **Real-world usage** of the scraping infrastructure
- **Best practices** for resource management
- **Common patterns** developers will use
- **Error handling** and recovery
- **Performance considerations** (parallel processing, rate limiting, etc.)

## Naming Conventions
- `start-pages` - Working with site start pages
- `session-management` - Session creation, reuse, cleanup
- `proxy-handling` - Proxy configuration and rotation
- `data-extraction` - Scraping and data processing
- `error-recovery` - Handling failures and retries
- `rate-limiting` - Respecting rate limits and timeouts

## Template Structure
```typescript
/**
 * Example: <Brief description>
 * Usage: npm run example:<name> [args]
 */

import { logger } from '../src/lib/logger.js';
// ... other imports

const log = logger.createContext('example-name');

async function main() {
  try {
    // Main example logic here
    
  } catch (error) {
    log.error('Example failed:', error);
    process.exit(1);
  } finally {
    // Cleanup logic here
  }
}

main();
```