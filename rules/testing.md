# Testing Guide

## Overview

This document outlines the testing requirements and best practices for the scraping infrastructure project.

## Testing Requirements

For tests to pass and be considered valid, they must meet two criteria:

### 1. Functional Correctness
Tests must verify that the code behaves as expected and all assertions pass.

### 2. Architecture Compliance
Both test files and the code they test MUST conform to the architecture defined in `architecture.md`. This means:

- **Test imports must follow the same layering rules** as production code
- **Tests should not bypass architectural boundaries** for convenience
- **Mock at the appropriate layer** - if testing a service, mock the drivers it uses, not the providers

## Architecture Rules for Tests

### Import Hierarchy in Tests

Tests must follow the same import rules as production code:

```typescript
// ✅ CORRECT: Test imports from the same layer it's testing
// tests/services/session-manager.test.ts
import { SessionManager } from '../../src/services/session-manager.js';
import { createBrowserbaseSession } from '../../src/drivers/browser.js';

// ❌ WRONG: Test bypassing layers
// tests/services/session-manager.test.ts
import { createSession } from '../../src/providers/browserbase.js'; // NO!
```

### Mocking Strategy

Mock at the layer boundary:

```typescript
// Testing a service? Mock the drivers it uses
vi.mock('../../src/drivers/browser.js');
vi.mock('../../src/drivers/scrape-runs.js');

// Testing a driver? Mock the providers it uses
vi.mock('../../src/providers/browserbase.js');
vi.mock('../../src/providers/local-browser.js');
```

## Running Tests

```bash
# Run all tests once
npm test

# Run tests in watch mode
npm run test:watch

# Run specific test file
npm test tests/distributor.test.ts
```

## Common Test Issues

### External Service Failures

Some tests depend on external services like httpbin.org. If these services are down:

- **503 Service Unavailable**: Tests will fail - this is expected behavior
- We intentionally DO NOT handle external service failures in tests
- Failed tests due to external services indicate service availability issues, not code problems

**Tests that depend on httpbin.org:**
- `tests/browser.test.ts` - "Local browser session"
- `tests/cache.test.ts` - All cache tests
- `tests/integration.test.ts` - "Integration - session without proxy"

**Current Status:**
- All 72 tests passing (8 test files)
- Architecture compliance verified - all imports follow layering rules
- External services (httpbin.org) currently operational
- Note: Test failures due to 503 errors indicate external service issues, not code problems

### Import Path Issues

If you see errors like:
```
Error: Failed to load url ../lib/logger.js (resolved id: ../lib/logger.js)
```

This indicates an architecture violation. Check that:
1. The import path follows the correct layering
2. The file hasn't been moved to a different layer
3. Tests are importing from the correct layer

## Test Organization

```
tests/
├── providers/          # Test provider integrations
├── drivers/            # Test driver abstractions
├── services/           # Test service managers
├── core/               # Test pure business logic
├── engines/           # Test engine orchestration
└── integration/       # End-to-end integration tests
```

## Best Practices

1. **Test at the Right Level**: Unit test individual functions, integration test across layers
2. **Follow the Architecture**: Don't bypass layers even in tests
3. **Mock External Dependencies**: For reliable, fast tests
4. **Test Pure Functions Purely**: Core functions should be tested without any mocks
5. **Document External Dependencies**: Note when tests require external services

## Example Test Structure

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SiteManager } from '../../src/services/site-manager.js';

// Mock at the driver layer (one level down from services)
vi.mock('../../src/drivers/scrape-runs.js');
vi.mock('../../src/drivers/site-config.js');

describe('SiteManager', () => {
  let siteManager: SiteManager;

  beforeEach(() => {
    vi.clearAllMocks();
    siteManager = new SiteManager();
  });

  it('should load sites from driver', async () => {
    // Test implementation
  });
});
```

## CI/CD Considerations

In CI environments:
- All tests must pass (except documented external service failures)
- Architecture compliance is mandatory
- Consider adding architecture linting tools
- Run tests with `--reporter=verbose` for better debugging