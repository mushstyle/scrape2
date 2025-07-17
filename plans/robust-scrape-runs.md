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
  collectedUrls: string[];
  failureCount: number;
  failureHistory: Array<{
    timestamp: Date;
    proxy: string;
    error: string;
  }>;
  completed: boolean; // Explicitly track if pagination ran to completion
}

interface PartialScrapeRun {
  siteId: string;
  paginationStates: Map<string, PaginationState>;
  totalUrlsCollected: number;
  createdAt: Date;
  committedToDb: boolean;
}

interface ProxyBlocklistEntry {
  proxy: string;
  failedAt: Date;
  failureCount: number;
  lastError: string;
}

interface SiteState {
  // ... existing fields ...
  proxyBlocklist: Map<string, ProxyBlocklistEntry>; // key is proxy string
}

// Update SiteConfig to include blocked proxies
interface SiteConfig {
  // ... existing fields ...
  blockedProxies?: string[]; // Proxies to exclude for this site
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
    
    // Check if ANY pagination returned 0 URLs
    const hasEmptyPagination = Array.from(this.partialRun.paginationStates.values())
      .some(s => s.completed && s.collectedUrls.length === 0);
    
    if (hasEmptyPagination) {
      throw new Error('Pagination returned 0 URLs - aborting entire run');
    }
    
    // Check if all paginations completed successfully
    const allCompleted = Array.from(this.partialRun.paginationStates.values())
      .every(s => s.completed && s.collectedUrls.length > 0);
    
    if (!allCompleted) {
      throw new Error('Not all paginations completed successfully');
    }
    
    // Only if ALL paginations succeeded with URLs
    const allUrls = Array.from(this.partialRun.paginationStates.values())
      .flatMap(s => s.collectedUrls);
    
    // Create scrape run via driver - only succeeds if no exceptions
    const run = await this.scrapeRunsDriver.createRun({
      siteId: this.partialRun.siteId,
      urls: allUrls
    });
    
    this.partialRun.committedToDb = true;
    this.partialRun = undefined; // Clear ONLY after successful DB write
    
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

### Proxy Blocklist Management

```typescript
class SiteManager {
  // Get cooldown period from proxy configuration
  private getProxyCooldownMinutes(domain: string): number {
    // Get from proxy strategy configuration
    const strategy = getProxyStrategyForDomain(domain);
    return strategy?.cooldownMinutes || 30; // Default 30 min
  }
  
  // Add proxy to blocklist (datacenter only)
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
  
  // Get blocked proxies and clean up expired entries
  getBlockedProxies(domain: string): string[] {
    const site = this.getSite(domain);
    if (!site) return [];
    
    const now = new Date();
    const cooldownMinutes = this.getProxyCooldownMinutes(domain);
    const blocked: string[] = [];
    
    // Check each entry and remove if past cooldown
    for (const [proxy, entry] of site.proxyBlocklist) {
      const minutesSinceFailure = (now.getTime() - entry.failedAt.getTime()) / (1000 * 60);
      if (minutesSinceFailure >= cooldownMinutes) {
        // Remove from blocklist entirely
        site.proxyBlocklist.delete(proxy);
      } else {
        blocked.push(proxy);
      }
    }
    
    return blocked;
  }
  
  /**
   * Get site configurations, optionally including blocked proxies
   * @param includeBlockedProxies - Whether to include blockedProxies field (default: true)
   * @returns Array of site configs, with blockedProxies field if requested
   */
  getSiteConfigs(includeBlockedProxies: boolean = true): SiteConfig[] {
    return Array.from(this.sites.values()).map(site => {
      if (!includeBlockedProxies) {
        return site.config;
      }
      
      return {
        ...site.config,
        blockedProxies: this.getBlockedProxies(site.domain)
      };
    });
  }
}
```

## Key Design Decisions

1. **Partial Run State**: Track pagination progress per startPage in memory
2. **Atomic Commits**: Only flush to DB when ALL paginations complete successfully
3. **Zero URLs = Abort**: If any pagination returns 0 URLs, abort entire run
4. **Network Errors = Retry**: Allow retries for network failures
5. **Proxy Blocklist**: Only for datacenter proxies (residential rotate anyway)
6. **Auto-cleanup**: Proxies removed from blocklist after cooldown expires
7. **Cooldown from Config**: Get cooldown period from proxy strategy configuration
8. **getSiteConfigs Enhancement**: Returns blocked proxies by default for distributor

## Implementation Steps
1. [ ] Add PartialScrapeRun and PaginationState types with failure tracking
2. [ ] Extend SiteManager with partial run tracking
3. [ ] Add proxy blocklist to SiteState (Map<string, ProxyBlocklistEntry>)
4. [ ] Implement proxy failure tracking (datacenter only)
5. [ ] Add auto-cleanup logic for expired blocked proxies
6. [ ] Get cooldown period from proxy strategy configuration
7. [ ] Update getSiteConfigs to include blockedProxies field
8. [ ] Add validation in commitPartialRun (check for 0 URLs, all complete)
9. [ ] Ensure partial run only cleared after successful DB flush