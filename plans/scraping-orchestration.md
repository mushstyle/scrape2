# Scraping Orchestration Plan

**Goal:** Build a web scraping orchestration system with a pure functional distributor core that assigns ScrapeRunItems to browser sessions, supported by managers for external state and API interactions.

## Implementation Steps

[ ] 1. Create type definitions
   - [ ] Create `src/types/scrape-run.ts` with ScrapeRunItem, ScrapeRun, and API types
   - [ ] Create `src/types/orchestration.ts` with DistributionResult, SessionStats, ItemStats types
   - [ ] Ensure all types are properly exported and importable

[ ] 2. Implement ETL API provider
   - [ ] Create `src/providers/etl-api.ts` with environment variable configuration
   - [ ] Implement `createScrapeRun()` function with proper request/response types
   - [ ] Implement `fetchScrapeRun()` function with error handling
   - [ ] Implement `listScrapeRuns()` with query parameter support
   - [ ] Implement `updateScrapeRunItem()` for status updates
   - [ ] Implement `finalizeScrapeRun()` for run completion
   - [ ] Implement `getLatestRunForDomain()` convenience function
   - [ ] Add `normalizeRunResponse()` helper for field name variations
   - [ ] Add `buildApiUrl()` helper for consistent URL construction
   - [ ] Write unit tests for all API functions with mocked responses

[ ] 3. Implement pure functional distributor
   - [ ] Create `src/lib/distributor.ts` with `itemsToSessions()` function
   - [ ] Implement round-robin distribution strategy
   - [ ] Implement domain-affinity distribution strategy
   - [ ] Implement least-loaded distribution strategy
   - [ ] Add filtering for completed items (done === true)
   - [ ] Ensure function returns exactly sessions.length results
   - [ ] Write comprehensive unit tests for all strategies
   - [ ] Test edge cases: empty items, empty sessions, single session

[ ] 4. Implement session manager
   - [ ] Create `src/lib/session-manager.ts` with session tracking
   - [ ] Implement `getActiveSessions()` with provider integration
   - [ ] Implement `createSession()` using browserbase/local providers
   - [ ] Implement `destroySession()` with proper cleanup
   - [ ] Implement `getSessionStats()` for load balancing
   - [ ] Implement `refreshSessions()` for health checks
   - [ ] Add session pooling and timeout management
   - [ ] Write integration tests with mocked providers

[ ] 5. Implement scrape run manager
   - [ ] Create `src/lib/scrape-run-manager.ts` for run lifecycle
   - [ ] Implement `createRun()` with domain and optional URLs
   - [ ] Implement `getActiveRun()` to find existing runs
   - [ ] Implement `getPendingItems()` filtering done items
   - [ ] Implement `updateItemStatus()` with batch support
   - [ ] Implement `finalizeRun()` with metadata calculation
   - [ ] Implement `getRunStats()` for progress tracking
   - [ ] Write integration tests with mocked ETL API

[ ] 6. Create integration example
   - [ ] Create `examples/orchestration-demo.ts` showing full workflow
   - [ ] Demonstrate creating/resuming runs
   - [ ] Show distribution strategies in action
   - [ ] Include error handling examples
   - [ ] Add performance monitoring example

[ ] 7. Update documentation
   - [ ] Update architecture.md with orchestration system overview
   - [ ] Add API documentation for all exported functions
   - [ ] Create troubleshooting guide for common issues
   - [ ] Update CLAUDE.md with orchestration patterns

**Key Considerations:**

- [ ] ETL API requires `ETL_API_ENDPOINT` and `ETL_API_KEY` environment variables
- [ ] Handle API field name variations (_id vs id, createdAt vs created_at)
- [ ] Distributor must filter out completed items before distribution
- [ ] Session manager needs to handle both browserbase and local providers
- [ ] Consider implementing batch updates for performance with many items
- [ ] Add retry logic for transient API failures
- [ ] Monitor memory usage when handling large numbers of items
- [ ] Ensure proper TypeScript types throughout for maintainability
- [ ] Consider adding caching layer for frequently accessed run data
- [ ] Plan for concurrent run handling per domain