# Browserbase Session Reuse Plan

## Problem
Browserbase sessions are being terminated unexpectedly, causing 410 Gone errors when trying to reuse them in subsequent batches. The current implementation assumes sessions remain active but doesn't verify their actual status with browserbase.

## Solution
Implement proper session status checking before reuse by:
1. Having SessionManager query browserbase API to get actual running sessions
2. Only reusing sessions that are confirmed as RUNNING
3. Creating new sessions to fill any gaps

## Implementation Steps

### Phase 1: Update Browserbase Provider
- [ ] Add `getActiveSessions()` method to browserbase provider that calls the list sessions API
- [ ] Filter sessions to only return those with status RUNNING
- [ ] Add proper typing for browserbase session status

### Phase 2: Update SessionManager
- [ ] Before returning active sessions, verify with browserbase which are actually running
- [ ] Remove any sessions from tracking that browserbase reports as terminated
- [ ] Ensure proper cleanup of terminated sessions

### Phase 3: Create Test Script
- [ ] Create `examples/test-browserbase-sessions.ts` to verify the implementation
- [ ] Test creating sessions, listing them, and verifying status
- [ ] Output full browserbase response to confirm behavior

### Phase 4: Integration Testing
- [ ] Test with paginate engine to ensure sessions are properly reused
- [ ] Verify no 410 Gone errors occur
- [ ] Confirm terminated sessions are not reused

## Technical Details

### Browserbase List Sessions API
- Endpoint: GET https://api.browserbase.com/v1/sessions
- Returns array of sessions with status field
- Status values: RUNNING, COMPLETED, FAILED, etc.

### Architecture Compliance
- Provider layer: Handles browserbase API communication
- SessionManager: Orchestrates session lifecycle and status checks
- No changes to engines - they continue to request sessions normally