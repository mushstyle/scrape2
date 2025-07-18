# Plan: Replace Manager Tests with Production Standards

## Current State
- **SessionManager**: NO TESTS EXIST (critical gap)
- **SiteManager**: Basic tests exist in `tests/site-manager.test.ts` (19 test cases)
- **Integration**: No SessionManager + SiteManager integration tests

## Goals
**DELETE ALL EXISTING TESTS** for the managers, and replace with production-standard unit tests that focus on:
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

### 3. NO Integration Tests - Unit Tests Only
**We will NOT create integration tests**. All manager interactions will be tested through unit tests with mocks.

#### Why No Integration Tests:
- Manager interactions are deterministic given their contracts
- Unit tests with mocks can verify all behavioral properties
- Faster, more reliable, easier to maintain
- Integration complexity belongs at the driver layer (existing `integration.test.ts`)

#### Instead, Unit Tests Will Cover:
- Mock SiteManager in SessionManager tests
- Mock SessionManager in SiteManager tests
- Test the contracts between them
- Verify proper method calls and data flow

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

### Phase 3: Performance Tests (Optional)
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
- [ ] All tests run in <5 seconds total
- [ ] No flaky tests
- [ ] Clear test names describing properties being tested
- [ ] DELETE old test files before creating new ones

## Notes

- Use Vitest (existing test framework)
- Mock drivers at module level
- Use descriptive test names that explain the property
- Group related tests in describe blocks
- Each test should test ONE property clearly