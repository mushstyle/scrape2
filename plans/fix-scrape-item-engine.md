# Plan: Fix Scrape Item Engine Based on Paginate Engine Improvements

## Overview
The scrape-item-engine has several critical bugs and inefficiencies compared to the paginate-engine. This plan outlines the necessary fixes to bring it up to the same level of robustness and performance.

## Critical Issues to Fix

### 1. Session ID Handling (CRITICAL)
**Problem**: Using fake IDs like `existing-${i}` breaks session matching
**Solution**: Copy the proper session ID extraction from paginate-engine:
- Add `getSessionId()` method that extracts real IDs from browserbase/local sessions
- Update `convertSessionsToSessionData()` to use real session IDs

### 2. Browserbase Proxy Information (CRITICAL)
**Problem**: Only checking `session.local?.proxy` loses browserbase proxy info
**Solution**: Check the correct field based on provider:
- `session.browserbase?.proxy` for browserbase sessions
- `session.local?.proxy` for local sessions

### 3. Session Reuse Between Batches (HIGH PRIORITY)
**Problem**: Sessions are destroyed after each batch, preventing reuse
**Solution**: 
- Make `sessionDataMap` a class member instead of local variable
- Remove `cleanupBrowsers()` call between batches
- Only cleanup at the very end in a finally block
- Reset `inUse` flags at start of each batch

### 4. Session Creation Race Condition (HIGH PRIORITY)
**Problem**: Using Promise.all with individual createSession calls
**Solution**: Pass array of session requests to createSession (already supports arrays)

### 5. Browser Closed Error Handling (MEDIUM PRIORITY)
**Problem**: Would crash on "Target page, context or browser has been closed" errors
**Solution**:
- Add special handling for target closed errors in `processItemWithRetries()`
- Add `page.unrouteAll({ behavior: 'ignoreErrors' })` before page.close()
- Update cache.ts error handling (already done)

### 6. Session Cleanup Method (MEDIUM PRIORITY)
**Problem**: Calling non-existent `session.cleanup()`
**Solution**: Use `sessionManager.destroySessionByObject(session)`

### 7. Session Limit Configuration (MEDIUM PRIORITY)
**Problem**: SessionManager not configured with correct limit
**Solution**: Pass `instanceLimit` to SessionManager constructor

## Additional Critical Issues

### 8. Fix Dangerous Batch Upload Pattern (CRITICAL)
**Problem**: Items are collected in memory and only uploaded at the very end
**Risks**:
- If process crashes, ALL scraped items are lost
- If any batch fails, previous successful batches are lost
- Memory usage grows unbounded with large item sets
- Items not marked as done until end, causing re-scraping on retry

**Solution**: Upload items and update status after EACH batch:
- Upload batch items to ETL immediately after scraping
- Mark items as done in the database after successful upload
- Remove the accumulation of `allScrapedItems`
- This ensures work is never lost or redone

### 9. Add Proper Cleanup in Finally Block
Ensure all sessions are destroyed at the very end, even if errors occur.

## Implementation Steps

1. **Update Session ID Handling**
   - Add `getSessionId()` method
   - Fix `convertSessionsToSessionData()`

2. **Fix Proxy Information Extraction**
   - Update proxy field access based on provider type

3. **Make Sessions Persistent Across Batches**
   - Move `sessionDataMap` to class member
   - Add `inUse` flag reset logic
   - Remove mid-process cleanup

4. **Fix Session Creation**
   - Change from Promise.all to array-based createSession

5. **Add Robust Error Handling**
   - Handle target closed errors specially
   - Add page.unrouteAll before close
   - Update processItemWithRetries error logic

6. **Fix Session Management**
   - Replace cleanup() with destroySessionByObject()
   - Pass instanceLimit to SessionManager

7. **Fix Batch Upload Pattern**
   - Remove `allScrapedItems` accumulation
   - Upload items after each batch
   - Update item status immediately after upload
   - Remove the final batch upload logic

8. **Test Thoroughly**
   - Test with multiple batches to ensure session reuse
   - Test with browserbase to ensure proxy persistence
   - Test error scenarios (browser crashes, network errors)

## Expected Benefits

- **Performance**: Dramatic speedup from session reuse between batches
- **Reliability**: Won't crash on browser errors, proper retry handling
- **Correctness**: Proper proxy matching, correct session limits
- **Efficiency**: Fewer session creations, better resource utilization
- **Data Safety**: No data loss on crashes, no duplicate work
- **Progress Tracking**: Items marked done immediately, accurate progress

## Testing Plan

1. Run with large item sets that require multiple batches
2. Verify sessions are reused (check logs for "existing sessions")
3. Test with browserbase to ensure proxy info persists
4. Simulate browser crashes to test error handling
5. Verify batch upload still works efficiently