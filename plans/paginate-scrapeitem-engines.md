# Paginate and ScrapeItem Engines Plan

## Goal
**Create production-ready engines for paginating sites and scraping individual items that can be invoked from both CLI and API endpoints, with full status visibility and caching support.**

## Key Requirements
1. All activity must affect the in-memory singletons of SiteManager and SessionManager
2. Must be callable from both CLI and API endpoints
3. Status must be queryable via API even if started from CLI
4. Must implement caching (currently missing from pagination-live.ts)
5. Must follow the strict layered architecture (engines → services → drivers → providers)

## Architecture Overview

### Engine Design Pattern
- **PaginateEngine**: Handles pagination across multiple sites with the double-pass matcher pattern
- **ScrapeItemEngine**: Handles scraping individual items or batches of items
- Both engines will be classes in `src/engines/` following the existing pattern
- Both will accept and use injected SessionManager and SiteManager instances (ensuring singleton usage)

### State Management for CLI/API Interoperability
To enable status checking from API for CLI-initiated tasks:
- Engines will register active tasks in SiteManager using a new `ActiveTask` tracking system
- Each task gets a unique ID that can be queried
- Tasks update their progress in real-time via SiteManager methods

## Implementation Plan

### [ ] 1. Create ActiveTask Tracking System in SiteManager
- [ ] Add types to `src/types/site-manager-types.ts`:
  ```typescript
  interface ActiveTask {
    id: string;
    type: 'paginate' | 'scrapeItem';
    status: 'running' | 'completed' | 'failed';
    startedAt: Date;
    updatedAt: Date;
    progress: {
      total: number;
      completed: number;
      failed: number;
    };
    metadata: {
      sites?: string[];
      urls?: string[];
      instanceLimit?: number;
    };
    error?: string;
  }
  ```
- [ ] Add methods to SiteManager:
  - [ ] `registerActiveTask(task: ActiveTask): void`
  - [ ] `updateTaskProgress(taskId: string, progress: Partial<ActiveTask['progress']>): void`
  - [ ] `getActiveTask(taskId: string): ActiveTask | null`
  - [ ] `getActiveTasks(): ActiveTask[]`
  - [ ] `completeTask(taskId: string, status: 'completed' | 'failed', error?: string): void`
- [ ] Store tasks in memory map within SiteManager

### [ ] 2. Create PaginateEngine
- [ ] Create `src/engines/paginate-engine.ts` with:
  - [ ] Constructor accepting SessionManager and SiteManager instances
  - [ ] Options interface:
    ```typescript
    interface PaginateOptions {
      sites: string[];
      instanceLimit: number;
      maxPages?: number;
      enableCache?: boolean;
      cacheSize?: number;
      taskId?: string; // For tracking
    }
    ```
  - [ ] Result interface:
    ```typescript
    interface PaginateResult {
      taskId: string;
      success: boolean;
      sitesProcessed: number;
      totalUrls: number;
      urlsBySite: Map<string, string[]>;
      errors: string[];
      duration: number;
      cacheStats?: CacheStats;
    }
    ```
- [ ] Implement double-pass matcher pattern from pagination-live.ts
- [ ] Add RequestCache integration:
  - [ ] Create shared cache instance at engine level
  - [ ] Enable cache for all pages before navigation
  - [ ] Track cache statistics
- [ ] Register task with SiteManager at start
- [ ] Update task progress after each site/page
- [ ] Use SiteManager's partial run tracking:
  - [ ] Call `startPagination()` for each site
  - [ ] Call `updatePaginationState()` after each page
  - [ ] Call `commitPartialRun()` after each site completes
- [ ] Handle errors gracefully with retry logic
- [ ] Complete task in SiteManager when done

### [ ] 3. Create ScrapeItemEngine  
- [ ] Create `src/engines/scrape-item-engine.ts` with:
  - [ ] Constructor accepting SessionManager and SiteManager instances
  - [ ] Options interface:
    ```typescript
    interface ScrapeItemOptions {
      urls: string[]; // Can be single or batch
      instanceLimit?: number;
      enableCache?: boolean;
      cacheSize?: number;
      taskId?: string;
      saveToDatabase?: boolean;
    }
    ```
  - [ ] Result interface:
    ```typescript
    interface ScrapeItemResult {
      taskId: string;
      success: boolean;
      itemsScraped: number;
      items: Map<string, any>; // url -> item data
      errors: Map<string, string>; // url -> error
      duration: number;
      cacheStats?: CacheStats;
    }
    ```
- [ ] Implement URL grouping by domain
- [ ] Use distributor for URL-session matching
- [ ] Add RequestCache integration
- [ ] Register and update task progress
- [ ] Support both single item and batch scraping
- [ ] Optionally save items to database via ItemsDriver

### [ ] 4. Create CLI Commands
- [ ] Update `src/cli/commands/scrape.ts` to add new subcommands:
  - [ ] `scrape paginate` command:
    ```bash
    npm run scrape paginate -- --sites=site1.com,site2.com --instance-limit=10 --max-pages=5 --enable-cache
    ```
  - [ ] `scrape items` command:
    ```bash
    npm run scrape items -- --urls=url1,url2,url3 --instance-limit=5 --enable-cache --save
    ```
- [ ] Both commands should:
  - [ ] Get singleton instances of SessionManager and SiteManager
  - [ ] Create appropriate engine with those instances
  - [ ] Generate a task ID
  - [ ] Run the engine
  - [ ] Display progress and results

### [ ] 5. Create API Endpoints
- [ ] Create `src/api/routes/tasks.ts`:
  - [ ] `GET /api/tasks` - List all active tasks
  - [ ] `GET /api/tasks/:taskId` - Get specific task status
  - [ ] `POST /api/tasks/paginate` - Start pagination task
  - [ ] `POST /api/tasks/scrape-items` - Start item scraping task
- [ ] All endpoints use the same singleton SessionManager and SiteManager
- [ ] POST endpoints create engines and start tasks asynchronously
- [ ] Return task ID immediately for status checking

### [ ] 6. Testing Strategy
- [ ] Unit tests for engines:
  - [ ] Mock SessionManager and SiteManager
  - [ ] Test double-pass matcher integration
  - [ ] Test cache behavior
  - [ ] Test error handling and retries
- [ ] Integration tests:
  - [ ] Test CLI commands with real sites
  - [ ] Test API endpoints
  - [ ] Test CLI-started task visibility in API
- [ ] Add to existing test commands

### [ ] 7. Documentation Updates
- [ ] Update `README.md` with new CLI commands
- [ ] Create `docs/engines.md` explaining:
  - [ ] How engines work
  - [ ] CLI vs API usage
  - [ ] Task tracking system
  - [ ] Caching behavior
- [ ] Update `rules/architecture.md` if needed

## Key Considerations

- [ ] **Singleton Pattern**: Both CLI and API must use the same SessionManager and SiteManager instances. This might require a singleton factory pattern or dependency injection.
- [ ] **Task Persistence**: Currently tasks are only in-memory. Consider if we need database persistence for long-running tasks.
- [ ] **Concurrency**: Multiple tasks might run simultaneously. Ensure SessionManager limits are respected globally.
- [ ] **Memory Management**: With caching enabled, monitor memory usage especially for large pagination runs.
- [ ] **Error Recovery**: Implement proper cleanup on errors (close browsers, update task status, etc.)
- [ ] **Progress Reporting**: Consider adding WebSocket support for real-time progress updates in API.
- [ ] **Cache Invalidation**: Determine cache TTL strategy - should cache persist between runs?
- [ ] **Rate Limiting**: Ensure engines respect site-specific rate limits if configured.

## Success Criteria

1. Can start pagination from CLI and check status via API endpoint
2. Can start item scraping from API and see results
3. Caching improves performance by >30% for multi-page pagination
4. All activity is reflected in SiteManager's state (partial runs, blocked proxies, etc.)
5. Errors in one site don't affect others
6. Clean shutdown handles all browser cleanup properly
7. Memory usage stays reasonable even with large batches