# Fix Browser Crash Handlers Plan

## Problem
When a browser gets disconnected (e.g., Browserbase session expires or crashes), Playwright emits events that throw TargetClosedError outside of our try-catch blocks, crashing the entire scrape run. 

Current behavior:
- We detect browser closed errors in processItemWithRetries
- We mark sessions as invalidated when browser crashes
- But unhandled errors from Playwright's internal event emitters still crash the process

## Root Cause
Playwright's browser, context, and page objects have internal event emitters that can throw errors asynchronously when the connection is lost. These errors happen outside our try-catch blocks.

## Solution
Add error event handlers to browser and context objects to catch and handle disconnection errors gracefully.

## Implementation Status: COMPLETED

### 1. Created global error handlers utility (src/utils/error-handlers.ts)
- `installGlobalErrorHandlers()` - Installs process-level handlers for unhandled rejections and uncaught exceptions
- `isBrowserError()` - Identifies browser-related errors that should not crash the process
- `withBrowserErrorHandling()` - Wrapper function for graceful error handling

### 2. Updated browser.ts to add error handlers
- Added 'disconnected' and 'error' event handlers for both Browserbase and local browsers
- Added 'error' and 'close' event handlers for contexts
- Errors are logged but don't crash the process

### 3. Updated page creation in both engines
- Added error handlers in scrape-item-engine.ts processItem()
- Added error handlers in paginate-engine.ts processUrl()
- Pages now handle 'error', 'crash', and 'close' events

### 4. Enhanced browser closed detection
- Updated isBrowserClosedError() in scrape-item-engine.ts with more error patterns
- Added detection for: connection closed, browser is closed, execution context destroyed, page closed

### 5. Installed global handlers in all entry points
- scripts/scrape.ts
- scripts/verify-item.ts
- scripts/verify-paginate.ts

### 6. Added tests
- Created tests/error-handlers.test.ts to verify error detection logic

## Benefits
- Prevents browser crashes from killing the entire run
- Properly handles disconnected browsers without process termination
- Sessions are correctly marked as invalidated and cleaned up
- Other healthy sessions continue processing
- No major refactoring needed - just adding error handlers

## Testing
1. Run a long item scrape with short session timeout (--session-timeout 60)
2. Let some sessions expire during processing
3. Verify the run continues with remaining sessions
4. Check that expired sessions are properly cleaned up