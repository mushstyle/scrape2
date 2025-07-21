# Retry Failed Items with Proxy Rotation Plan

## Problem
1. When items fail due to network errors, they're marked as `failed: true` and filtered out by SiteManager
2. Network errors retry on the same proxy session, which often fails if the proxy is blocked
3. The `blockedProxies` array exists but isn't used by proxy selection
4. No way to retry failed items with different proxies

## Solution Overview
Add ability to retry failed items using different proxies by:
1. Optional inclusion of failed items in SiteManager queries
2. Making proxy selection respect blockedProxies
3. Auto-blocking proxies that repeatedly fail

## Implementation

### 1. SiteManager Changes (Primary Logic)

#### Update getPendingItems to optionally include failed items
```typescript
async getPendingItems(runId: string, limit?: number, includeFailedItems = false): Promise<ScrapeRunItem[]> {
  // Change filter to:
  const pending = items.filter(item => 
    !item.done && 
    !item.invalid && 
    (includeFailedItems || !item.failed)
  );
}
```

#### Update getPendingItemsWithLimits to pass through the option
```typescript
async getPendingItemsWithLimits(
  sites: string[], 
  totalLimit: number = Infinity,
  includeFailedItems = false
): Promise<Array<{ url: string; runId: string; domain: string }>>
```

#### Make getProxyForDomain respect blockedProxies
```typescript
async getProxyForDomain(domain: string): Promise<Proxy | null> {
  const blockedProxies = await this.getBlockedProxies(domain);
  return selectProxyForDomain(domain, blockedProxies);
}
```

#### Add method to block a proxy for a domain
```typescript
async addBlockedProxy(domain: string, proxyId: string): Promise<void> {
  const current = await this.getBlockedProxies(domain);
  if (!current.includes(proxyId)) {
    await updateSiteBlockedProxies(domain, [...current, proxyId]);
  }
}
```

### 2. Proxy Driver Changes

#### Update selectProxyForDomain to accept excludeList
```typescript
export async function selectProxyForDomain(
  domain: string, 
  excludeProxyIds: string[] = []
): Promise<Proxy | null> {
  // ... existing logic
  
  // Filter out blocked proxies
  const candidateProxies = proxyStore.proxies.filter(proxy => {
    if (excludeProxyIds.includes(proxy.id)) return false;
    // ... rest of existing filters
  });
  
  // ... rest of selection logic
}
```

### 3. Engine Changes (Minimal)

#### Add option to scrape-item-engine
```typescript
export interface ScrapeItemOptions {
  retryFailedItems?: boolean;  // Include previously failed items
  // ... existing options
}
```

#### Pass option through collectPendingItems
```typescript
const urlsWithRunInfo = await this.siteManager.getPendingItemsWithLimits(
  sitesToProcess,
  itemLimit,
  options.retryFailedItems
);
```

#### Auto-block proxy on final network failure
```typescript
// In processItemWithRetries, after final network error:
if (isNetworkError && attempt === maxRetries) {
  const proxy = sessionData.session.provider === 'browserbase' 
    ? sessionData.session.browserbase?.proxy 
    : sessionData.session.local?.proxy;
    
  if (proxy?.id) {
    await this.siteManager.addBlockedProxy(runInfo.domain, proxy.id);
    log.normal(`Blocked proxy ${proxy.id} for ${runInfo.domain} after repeated failures`);
  }
  
  // Still mark as failed
  await this.siteManager.updateItemStatus(runInfo.runId, url, { failed: true });
}
```

### 4. Same changes for paginate-engine

- Add `retryFailedItems` option
- Pass through to SiteManager
- Auto-block proxies on repeated failures

### 5. CLI Updates

#### Add flag to scripts/scrape.ts
```typescript
.option('--retry-failed-items', 'Include previously failed items in scraping')
```

## Benefits

1. **Simple**: Most logic in SiteManager as requested
2. **Backwards Compatible**: Default behavior unchanged (failed items still filtered)
3. **Automatic Proxy Rotation**: Failed proxies excluded on retry
4. **Learning System**: Builds up blockedProxies list over time
5. **Flexible**: Can manually manage blockedProxies via API

## Usage Examples

```bash
# First run - some items fail due to blocked proxy
npm run scrape items --sites example.com

# Retry failed items - will automatically use different proxies
npm run scrape items --sites example.com --retry-failed-items

# Check blocked proxies for a site
npm run sites:config:get example.com | grep blockedProxies

# Clear blocked proxies if needed (via API)
```

## Testing

1. Run scrape with a proxy that will fail
2. Verify items marked as failed
3. Check proxy added to blockedProxies
4. Run with --retry-failed-items
5. Verify different proxy selected
6. Verify successful items marked as done