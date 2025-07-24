# Cache-Based Image Blocking Migration Plan

## Overview
We've successfully integrated image blocking directly into the RequestCache driver, which solves route handler conflicts and provides better bandwidth savings. This plan outlines how to migrate the entire project to use this approach consistently.

## Problem Solved
- Previously, image blocking was handled separately from caching, causing:
  - Route handler conflicts (cache handler intercepted requests before image blocking)
  - Images still being downloaded despite `blockImages: true`
  - Inconsistent behavior across different parts of the codebase
  - No tracking of blocked images

## New Approach
The RequestCache now accepts a `blockImages` option that:
1. Blocks images BEFORE checking cache (correct priority)
2. Tracks blocked images in stats
3. Works seamlessly with caching
4. Provides significant bandwidth savings

## Migration Steps

### 1. Update RequestCache Interface
Already completed - RequestCache constructor now accepts:
```typescript
constructor(options: CacheOptions & { blockImages?: boolean })
```

### 2. Remove Redundant Image Blocking

#### 2.1 Update Browser Driver (`src/drivers/browser.ts`)
- Remove the image blocking route handler from `createContext()`
- Remove lines 111-119 that add image blocking to context
- The `blockImages` option should become a no-op or deprecated

#### 2.2 Remove UnifiedRouteHandler (`src/drivers/unified-route-handler.ts`)
- This class is no longer needed since RequestCache handles both responsibilities
- Delete the entire file
- Remove import from browser.ts

### 3. Update Engines

#### 3.1 Paginate Engine (`src/engines/paginate-engine.ts`)
- Update cache creation to include `blockImages` option:
```typescript
this.globalCache = new RequestCache({
  maxSizeBytes: cacheSizeMB * 1024 * 1024,
  ttlSeconds: cacheTTLSeconds,
  blockImages: options.blockImages !== false  // Default to true
});
```

#### 3.2 Scrape Item Engine (`src/engines/scrape-item-engine.ts`)
- Same update as paginate engine
- Ensure `blockImages` option is properly propagated

### 4. Update Session Manager and Browser Creation

#### 4.1 Remove `blockImages` from Browser Options
- Update `createBrowserFromSession` to ignore/deprecate the `blockImages` option
- Add deprecation warning if the option is used

#### 4.2 Update Session Creation
- Ensure sessions don't try to handle image blocking
- All image blocking should be handled by RequestCache

### 5. Update Scripts and Examples

#### 5.1 Update All Scripts in `scripts/`
- Ensure they pass `blockImages` to cache options, not browser options
- Default should be `true` for bandwidth savings

#### 5.2 Update Integration Tests
- Update tests to verify image blocking works through cache
- Add tests for blocked image counting

### 6. Update Configuration and CLI

#### 6.1 CLI Options
- `--block-images` should control the cache's `blockImages` option
- Remove any browser-level image blocking flags
- Update help text to clarify this blocks images at the cache level

#### 6.2 Default Behavior
- Image blocking should default to `true` in production use
- Can be disabled with `--no-block-images` for debugging

### 7. Documentation Updates

#### 7.1 Update Architecture Docs
- Explain that image blocking is handled by the cache layer
- Remove references to separate image blocking mechanisms

#### 7.2 Update Cache Documentation (`rules/cache.md`)
- Document the `blockImages` option
- Explain the performance benefits
- Show example usage

## Implementation Order

1. **Phase 1: Core Updates** (Priority: High)
   - Update engines to use cache-based image blocking
   - Remove browser-level image blocking
   - Delete UnifiedRouteHandler

2. **Phase 2: Scripts and Tests** (Priority: Medium)
   - Update all scripts to use new approach
   - Add/update tests for image blocking
   - Verify no regressions

3. **Phase 3: Documentation** (Priority: Low)
   - Update all documentation
   - Add migration notes for any external users

## Benefits of This Approach

1. **Single Point of Control**: All request interception in one place
2. **Correct Priority**: Images blocked before cache checks
3. **Better Stats**: Track blocked images alongside cache stats
4. **No Conflicts**: Single route handler eliminates conflicts
5. **Bandwidth Savings**: Significant reduction in data usage

## Testing Checklist

- [ ] Verify images are blocked when `blockImages: true`
- [ ] Verify cache still works for non-image resources
- [ ] Check blocked image counter increments correctly
- [ ] Ensure no performance regression
- [ ] Test with both local and Browserbase sessions
- [ ] Verify CLI flags work correctly

## Rollback Plan

If issues arise:
1. Keep old image blocking code commented out initially
2. Can temporarily re-enable browser-level blocking
3. Monitor for any edge cases where cache-based blocking fails

## Success Metrics

- 80%+ reduction in bandwidth usage with image blocking enabled
- Zero image downloads when `blockImages: true`
- No route handler errors in logs
- Consistent behavior across all session types