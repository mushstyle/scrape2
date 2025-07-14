# Scraping Orchestration Plan

**Goal:** Build a web scraping orchestration system with a pure functional distributor core that assigns ScrapeRunItems to browser sessions, supported by managers for external state and API interactions.

## Implementation Steps

[x] 1. Create type definitions
   - [x] Create `src/types/scrape-run.ts` with ScrapeRunItem, ScrapeRun, and API types
   - [x] Create `src/types/orchestration.ts` with DistributionResult, SessionStats, ItemStats types
   - [x] Ensure all types are properly exported and importable

[x] 2. Implement ETL API provider
   - [x] Create `src/providers/etl-api.ts` with environment variable configuration
   - [x] Implement `createScrapeRun()` function with proper request/response types
   - [x] Implement `fetchScrapeRun()` function with error handling
   - [x] Implement `listScrapeRuns()` with query parameter support
   - [x] Implement `updateScrapeRunItem()` for status updates
   - [x] Implement `finalizeScrapeRun()` for run completion
   - [x] Implement `getLatestRunForDomain()` convenience function
   - [x] Add `normalizeRunResponse()` helper for field name variations
   - [x] Add `buildApiUrl()` helper for consistent URL construction
   - [ ] Write unit tests for all API functions with mocked responses

[x] 3. Implement pure functional distributor
   - [x] Create `src/lib/distributor.ts` with `itemsToSessions()` function
   - [x] Implement simple linear matching algorithm
   - [x] Return URL + Session pairs instead of grouped results
   - [x] Add filtering for completed items (done === true)
   - [x] Update to iterate through URLs then sessions
   - [x] Add session "works for URL" logic based on proxy requirements
   - [x] Support SiteConfig to determine proxy strategy matching
   - [x] Write comprehensive unit tests for linear distribution
   - [x] Test edge cases: empty items, empty sessions, single session, proxy matching

[x] 4. Implement session manager
   - [x] Create `src/lib/session-manager.ts` with session tracking
   - [x] Implement `getActiveSessions()` with provider integration
   - [x] Implement `createSession()` using browserbase/local providers
   - [x] Implement `destroySession()` with proper cleanup
   - [x] Implement `getSessionStats()` for load balancing
   - [x] Implement `refreshSessions()` for health checks
   - [x] Add session pooling and timeout management
   - [ ] Write integration tests with mocked providers

[x] 5. Implement scrape run manager
   - [x] Create `src/lib/scrape-run-manager.ts` for run lifecycle
   - [x] Implement `createRun()` with domain and optional URLs
   - [x] Implement `getActiveRun()` to find existing runs
   - [x] Implement `getPendingItems()` filtering done items
   - [x] Implement `updateItemStatus()` with batch support
   - [x] Implement `finalizeRun()` with metadata calculation
   - [x] Implement `getRunStats()` for progress tracking
   - [ ] Write integration tests with mocked ETL API

[x] 6. Create integration example
   - [x] Create `examples/orchestration-demo.ts` showing full workflow
   - [x] Demonstrate creating/resuming runs
   - [x] Show distribution strategies in action
   - [x] Include error handling examples
   - [ ] Add performance monitoring example

[x] 7. Update documentation
   - [x] Update architecture.md with orchestration system overview
   - [ ] Add API documentation for all exported functions
   - [ ] Create troubleshooting guide for common issues
   - [x] Update CLAUDE.md with orchestration patterns

**Key Considerations:**

- [x] ETL API requires `ETL_API_ENDPOINT` and `ETL_API_KEY` environment variables
- [x] Handle API field name variations (_id vs id, createdAt vs created_at)
- [x] Distributor must filter out completed items before distribution
- [x] Session manager needs to handle both browserbase and local providers
- [x] Consider implementing batch updates for performance with many items
- [ ] Add retry logic for transient API failures
- [ ] Monitor memory usage when handling large numbers of items
- [ ] Ensure proper TypeScript types throughout for maintainability
- [ ] Consider adding caching layer for frequently accessed run data
- [ ] Plan for concurrent run handling per domain