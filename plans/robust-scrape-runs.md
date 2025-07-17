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

## Network Failure Handling

### Pagination Failures
Track failures per URL and proxy usage:

```typescript
interface PaginationState {
  startPageUrl: string;
  status: 'pending' | 'paginating' | 'completed' | 'failed';
  collectedUrls: string[];
  error?: string;
  lastPageVisited?: string;
  totalPages?: number;
  currentPage?: number;
  // New failure tracking
  failureCount: number;
  failureHistory: Array<{
    timestamp: Date;
    proxy: string;
    error: string;
  }>;
}
```

### Proxy Blocklist (Per Site)
Track datacenter proxies that fail, with cooldown:

```typescript
interface ProxyBlocklistEntry {
  proxy: string;
  failedAt: Date;
  failureCount: number;
  lastError: string;
}

interface SiteState {
  // ... existing fields ...
  proxyBlocklist: Map<string, ProxyBlocklistEntry>;
}

class SiteManager {
  // Add proxy to blocklist
  addProxyToBlocklist(domain: string, proxy: string, error: string) {
    const site = this.getSite(domain);
    if (!site || !this.isDatacenterProxy(proxy)) return;
    
    const existing = site.proxyBlocklist.get(proxy);
    if (existing) {
      existing.failureCount++;
      existing.failedAt = new Date();
      existing.lastError = error;
    } else {
      site.proxyBlocklist.set(proxy, {
        proxy,
        failedAt: new Date(),
        failureCount: 1,
        lastError: error
      });
    }
  }
  
  // Get blocked proxies (excluding cooled down ones)
  getBlockedProxies(domain: string, cooldownMinutes: number = 30): string[] {
    const site = this.getSite(domain);
    if (!site) return [];
    
    const now = new Date();
    const blocked: string[] = [];
    
    for (const [proxy, entry] of site.proxyBlocklist) {
      const minutesSinceFailure = (now.getTime() - entry.failedAt.getTime()) / (1000 * 60);
      if (minutesSinceFailure < cooldownMinutes) {
        blocked.push(proxy);
      }
    }
    
    return blocked;
  }
  
  // Clean up old entries
  cleanupBlocklist(domain: string, maxAgeMinutes: number = 1440) { // 24 hours
    const site = this.getSite(domain);
    if (!site) return;
    
    const now = new Date();
    for (const [proxy, entry] of site.proxyBlocklist) {
      const minutesSinceFailure = (now.getTime() - entry.failedAt.getTime()) / (1000 * 60);
      if (minutesSinceFailure > maxAgeMinutes) {
        site.proxyBlocklist.delete(proxy);
      }
    }
  }
}
```

### Integration with Distributor
Pass blocked proxies when requesting sessions:

```typescript
// When getting proxy for pagination
async getProxyForPagination(domain: string): Promise<Proxy | null> {
  const blockedProxies = this.getBlockedProxies(domain);
  
  // Pass to distributor to exclude these proxies
  return selectProxyForDomain(domain, { 
    excludeProxies: blockedProxies 
  });
}
```

## Implementation Steps
1. [ ] Add PartialScrapeRun and PaginationState types with failure tracking
2. [ ] Extend SiteManager with partial run tracking
3. [ ] Add proxy blocklist to SiteState
4. [ ] Implement proxy failure tracking (datacenter only)
5. [ ] Add cooldown logic for blocked proxies
6. [ ] Update pagination logic to use new state tracking
7. [ ] Modify distributor to accept excluded proxy list
8. [ ] Ensure atomic commit via scrape-runs driver
9. [ ] Add guards against committing incomplete runs