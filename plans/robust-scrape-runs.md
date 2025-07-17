# Robust Scrape Runs Plan

## Goal
Handle partial pagination state during scrape run creation, tracking which start pages have been paginated and their collected URLs before committing to the database.

## Problem
When creating a scrape run, we paginate through all startPages to collect URLs. During this process:
- Some start pages may be fully paginated (URLs collected)
- Some may be in progress
- Some may have failed
- The current ScrapeRun type doesn't represent this partial pagination state

## Current State
- ScrapeRun has simple status: 'pending'/'processing'/'completed'/'failed'
- No way to track per-startPage pagination status
- All-or-nothing commit to DB via scrape-runs driver

## Solution: Enhanced In-Memory State

### New Types
```typescript
interface PaginationState {
  startPageUrl: string;
  status: 'pending' | 'paginating' | 'completed' | 'failed';
  collectedUrls: string[];
  error?: string;
  lastPageVisited?: string;
  totalPages?: number;
  currentPage?: number;
}

interface PartialScrapeRun {
  siteId: string;
  paginationStates: Map<string, PaginationState>;
  totalUrlsCollected: number;
  createdAt: Date;
  committedToDb: boolean;
}
```

### SiteManager Changes
```typescript
class SiteManager {
  // Add partial run tracking
  private partialRun?: PartialScrapeRun;
  
  // Track pagination progress
  async startPagination(siteId: string, startPages: string[]) {
    this.partialRun = {
      siteId,
      paginationStates: new Map(
        startPages.map(url => [url, {
          startPageUrl: url,
          status: 'pending',
          collectedUrls: []
        }])
      ),
      totalUrlsCollected: 0,
      createdAt: new Date(),
      committedToDb: false
    };
  }
  
  // Update individual pagination state
  updatePaginationState(startPageUrl: string, update: Partial<PaginationState>) {
    const state = this.partialRun?.paginationStates.get(startPageUrl);
    if (state) {
      Object.assign(state, update);
      if (update.collectedUrls) {
        this.partialRun.totalUrlsCollected = 
          Array.from(this.partialRun.paginationStates.values())
            .reduce((sum, s) => sum + s.collectedUrls.length, 0);
      }
    }
  }
  
  // Commit when all pagination complete
  async commitPartialRun(): Promise<ScrapeRun> {
    if (!this.partialRun || this.partialRun.committedToDb) {
      throw new Error('No partial run to commit');
    }
    
    // Collect all URLs from completed paginations
    const allUrls = Array.from(this.partialRun.paginationStates.values())
      .filter(s => s.status === 'completed')
      .flatMap(s => s.collectedUrls);
    
    // Create scrape run via driver
    const run = await this.scrapeRunsDriver.createRun(
      this.partialRun.siteId,
      allUrls
    );
    
    this.partialRun.committedToDb = true;
    this.partialRun = undefined; // Clear after commit
    
    return run;
  }
}
```

### Usage Flow
1. Start pagination: `startPagination(siteId, startPages)`
2. For each start page:
   - Update to 'paginating': `updatePaginationState(url, { status: 'paginating' })`
   - Collect URLs progressively: `updatePaginationState(url, { collectedUrls: [...] })`
   - Mark complete/failed: `updatePaginationState(url, { status: 'completed' })`
3. When all done, commit: `commitPartialRun()`

## Benefits
- Clear representation of partial pagination state
- Can track progress per start page
- Single atomic commit to DB when ready
- Can handle failures gracefully (skip failed start pages)
- In-memory state can be inspected for debugging

## Implementation Steps
1. [ ] Add PartialScrapeRun and PaginationState types
2. [ ] Extend SiteManager with partial run tracking
3. [ ] Update pagination logic to use new state tracking
4. [ ] Ensure atomic commit via scrape-runs driver
5. [ ] Add guards against committing incomplete runs