# Plan: Replace Manager Tests with Production Standards

## Current State
- **SessionManager**: NO TESTS EXIST (critical gap)
- **SiteManager**: Basic tests exist in `tests/site-manager.test.ts` (19 test cases)
- **Integration**: No SessionManager + SiteManager integration tests

## Goals
**DELETE ALL EXISTING TESTS** and replace with production-standard unit tests that focus on:
1. Core behavioral properties
2. Integration contracts between managers
3. Error handling and edge cases
4. Performance characteristics

## Test Structure

### 1. SessionManager Unit Tests (NEW)
Create `tests/session-manager.test.ts`:

#### Core Properties to Test:
- **Session Lifecycle**
  - Create single/multiple sessions with proper metadata
  - Enforce session limits correctly
  - Track active sessions accurately
  - Destroy sessions and clean up resources

- **Proxy Integration**
  - Sessions created with requested proxy config
  - Session metadata preserves proxy information
  - Handle missing/invalid proxy gracefully

- **Parallel Operations**
  - Batch session creation works correctly
  - Concurrent operations don't cause race conditions
  - Resource limits enforced under parallel load

- **Error Handling**
  - Provider failures handled gracefully
  - Partial batch failures return partial results
  - Cleanup works even after errors

### 2. SiteManager Unit Tests (REPLACE)
Replace `tests/site-manager.test.ts` with enhanced version:

#### Enhanced Properties to Test:
- **Proxy Blocklist Management**
  - Only datacenter proxies added to blocklist
  - Auto-cleanup based on cooldown period
  - Concurrent access to blocklist is safe
  - Integration with getSiteConfigsWithBlockedProxies()

- **Partial Run Management**
  - Full lifecycle: start → update → commit/abort
  - Commit fails if ANY pagination returns 0 URLs
  - State consistency throughout lifecycle
  - Cleanup only after successful DB write

- **Scrape Run Management**
  - Create pending vs committed runs
  - Run state transitions are atomic
  - Retry tracking works correctly
  - Stats calculation is accurate

### 3. Manager Integration Tests (NEW)
Create `tests/managers-integration.test.ts`:

#### Key Integration Properties:
- **Double-Pass Matcher Pattern**
  ```typescript
  test('double-pass matcher minimizes session creation', async () => {
    // Given: 3 existing sessions, 10 URLs, instance limit 5
    // First pass: Match what we can with existing
    // Second pass: Create only what's needed (2 more, not 5)
    // Assert: Total 5 sessions used, not 8
  });
  ```

- **Proxy Compatibility Flow**
  ```typescript
  test('respects proxy blocklist in session matching', async () => {
    // Given: Session with proxy-1, proxy-1 blocked for site.com
    // When: Try to match site.com URLs
    // Then: Session not used, new session created
  });
  ```

- **Resource Efficiency**
  ```typescript
  test('creates browsers only for used sessions', async () => {
    // Given: 5 sessions available, 2 URLs to process
    // When: Run distributor and create browsers
    // Then: Only 2 browsers created, not 5
  });
  ```

- **State Synchronization**
  ```typescript
  test('maintains consistent state between managers', async () => {
    // Throughout double-pass matcher flow
    // SessionManager active count matches actual sessions
    // SiteManager partial runs reflect operations
  });
  ```

## Implementation Plan

### Phase 1: SessionManager Tests (HIGH PRIORITY)
1. Create comprehensive test file from scratch
2. Mock all external dependencies (providers, drivers)
3. Test all core properties identified above
4. Add edge cases and error scenarios

### Phase 2: Replace SiteManager Tests
1. **DELETE `tests/site-manager.test.ts` entirely**
2. Create new test file from scratch
3. Add proxy blocklist tests
4. Add partial run lifecycle tests
5. Add concurrent operation tests
6. NO backwards compatibility - clean slate

### Phase 3: Integration Tests
1. Create new integration test file
2. Mock external APIs but test real manager interaction
3. Focus on double-pass matcher pattern
4. Test resource management properties
5. Verify state consistency

### Phase 4: Performance Tests (Optional)
1. Test session creation at scale
2. Test distributor performance with many URLs/sessions
3. Test memory usage under load

## Testing Principles

1. **Mock External Dependencies** - Tests should be fast and deterministic
2. **Test Behaviors, Not Implementation** - Focus on observable properties
3. **No Backwards Compatibility** - These are clean-slate tests
4. **Production Standards** - Error handling, concurrency, edge cases
5. **Delete First** - Remove old tests before writing new ones to avoid confusion

## Success Criteria

- [ ] 100% unit test coverage for SessionManager
- [ ] Enhanced SiteManager tests covering all new features
- [ ] Comprehensive integration tests for manager interaction
- [ ] All tests run in <5 seconds total
- [ ] No flaky tests
- [ ] Clear test names describing properties being tested

## Notes

- Use Vitest (existing test framework)
- Mock drivers at module level
- Use descriptive test names that explain the property
- Group related tests in describe blocks
- Each test should test ONE property clearly