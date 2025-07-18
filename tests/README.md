# Manager Tests

This directory contains production-standard unit tests for the service managers.

## Test Coverage

### SessionManager (`session-manager.test.ts`)
- **32 comprehensive unit tests** covering:
  - Session lifecycle (creation, retrieval, destruction)
  - Session limits and capacity management
  - Proxy integration and metadata preservation
  - Batch operations and concurrent handling
  - Error handling and edge cases
  - Usage tracking and statistics

### SiteManager (`site-manager.test.ts`)
- **26 comprehensive unit tests** covering:
  - Site configuration management
  - Proxy blocklist with auto-cleanup
  - Partial run lifecycle (pagination tracking)
  - Scrape run creation and management
  - Multi-site isolation and concurrent operations
  - Error handling and edge cases

## Test Philosophy
- **Unit tests only** - All external dependencies are mocked
- **Behavioral testing** - Focus on observable properties, not implementation
- **Fast execution** - All tests run in <5 seconds
- **Deterministic** - No flaky tests or external service dependencies
- **Production standards** - Error handling, concurrency, edge cases

## Running Tests
```bash
# Run all manager tests
npm test tests/session-manager.test.ts tests/site-manager.test.ts

# Run individually
npm test tests/session-manager.test.ts
npm test tests/site-manager.test.ts
```