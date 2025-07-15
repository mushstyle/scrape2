# Services/Managers Documentation

## Overview

Services (also called Managers) are stateful components that coordinate between drivers and provide high-level business operations. They maintain state, manage lifecycles, and expose domain-specific APIs to engines and other high-level components.

## Key Principles

1. **State Management**: Services maintain in-memory state for performance and consistency
2. **Driver Abstraction**: Services use drivers, never providers directly
3. **Business Logic**: Services implement stateful business logic and workflows
4. **Resource Management**: Services handle resource lifecycle (creation, pooling, cleanup)
5. **Domain Ownership**: Each service owns a specific domain of functionality

## SessionManager

### Purpose
Manages the lifecycle of browser sessions, including creation, pooling, and destruction. Provides a high-level API for session operations while abstracting the underlying provider details.

### Core Responsibilities

#### 1. **Session Lifecycle Management**
- Create new sessions (local or remote)
- Destroy sessions and clean up resources
- Track active sessions in memory
- Handle session timeouts and expiration

#### 2. **Session Pool Management**
- Maintain a pool of active sessions
- Enforce session limits
- Distribute sessions efficiently
- Reuse sessions when appropriate

#### 3. **Provider Abstraction**
- Abstract differences between local and remote browsers
- Handle provider-specific configurations
- Manage proxy assignment to sessions

#### 4. **Session State Tracking**
- Track session metadata (ID, creation time, provider type)
- Monitor session health and availability
- Maintain session-to-proxy mappings
- Track session usage statistics

### Key Methods
- `createSession()` - Create a new browser session
- `destroySession()` - Destroy a specific session
- `destroyAllSessions()` - Clean up all active sessions
- `getActiveSessions()` - Get all currently active sessions
- `getSession()` - Get a specific session by ID
- `getSessionCount()` - Get count of active sessions

### Usage Example
```typescript
const sessionManager = new SessionManager({
  sessionLimit: 10,
  provider: 'browserbase'
});

// Create a session
const sessionId = await sessionManager.createSession({ domain: 'example.com' });

// Get active sessions
const sessions = await sessionManager.getActiveSessions();

// Clean up
await sessionManager.destroySession(sessionId);
```

## SiteManager

### Purpose
Central hub for all site-related operations. Manages site configurations, scrape runs, URL tracking, retry logic, and data uploads. Acts as the single source of truth for site state and scraping progress.

### Core Responsibilities

#### 1. **Site Configuration Management**
- Load and cache site configurations from external sources
- Provide fast access to site-specific settings
- Track site metadata and custom data
- Handle site-specific proxy strategies

#### 2. **Scrape Run Management**
- Create and manage scrape runs (both committed and pending)
- Track run lifecycle (pending → processing → completed)
- Maintain run history per site
- Handle partial/uncommitted runs for incremental building

#### 3. **URL and Item Tracking**
- Track URL scraping status (pending, done, failed)
- Manage URL retry logic and retry counts
- Batch update item statuses
- Track failed URLs for retry attempts

#### 4. **Data Upload Coordination**
- Handle scraped data uploads
- Track upload status per URL
- Coordinate with storage systems
- Ensure data consistency

#### 5. **State Persistence**
- Maintain in-memory state for performance
- Sync with external APIs when needed
- Handle state recovery and consistency
- Cache frequently accessed data

#### 6. **Retry and Failure Management**
- Track retry attempts per URL
- Implement retry policies
- Manage failure thresholds
- Clear retry state when appropriate

### Key Methods

#### Site Configuration
- `loadSites()` - Load all site configurations
- `getSite()` - Get site state by domain
- `getSiteConfig()` - Get site configuration
- `getAllStartPages()` - Get start pages respecting limits
- `updateSite()` - Update site state
- `addSite()` - Add new site configuration

#### Scrape Run Management
- `createRun()` - Create new scrape run
- `createPendingRun()` - Create uncommitted run
- `commitPendingRun()` - Commit pending run to API
- `getActiveRun()` - Get current active run
- `getOrCreateRun()` - Get existing or create new run
- `finalizeRun()` - Mark run as completed
- `listRuns()` - List runs with filters
- `getRunStats()` - Get run statistics

#### Item/URL Management
- `getPendingItems()` - Get unprocessed items
- `updateItemStatus()` - Update single item status
- `updateItemStatuses()` - Batch update items
- `addUrlsToPendingRun()` - Add URLs to pending run

#### Retry Management
- `getRetryUrls()` - Get URLs needing retry
- `clearRetryTracking()` - Reset retry state

### Usage Example
```typescript
const siteManager = new SiteManager();
await siteManager.loadSites();

// Create a scrape run
const run = await siteManager.getOrCreateRun('example.com');

// Get pending items
const items = await siteManager.getPendingItems(run.id);

// Update item status after scraping
await siteManager.updateItemStatus(
  run.id, 
  'https://example.com/page1',
  { done: true },
  scrapedData // optional data to upload
);

// Get retry URLs
const retryUrls = siteManager.getRetryUrls('example.com', 3);

// Finalize run when done
await siteManager.finalizeRun(run.id);
```

## Best Practices

### 1. **State Consistency**
- Always update in-memory state before external APIs
- Handle API failures gracefully without corrupting state
- Use optimistic updates where appropriate

### 2. **Resource Management**
- Clean up resources in finally blocks
- Implement proper timeout handling
- Monitor resource usage and limits

### 3. **Error Handling**
- Log errors with context
- Propagate meaningful errors to callers
- Implement retry logic for transient failures

### 4. **Performance**
- Cache frequently accessed data
- Batch operations when possible
- Minimize external API calls

### 5. **Testing**
- Mock external dependencies (drivers)
- Test state transitions
- Verify resource cleanup

## Relationship Between Managers

### Separation of Concerns
- **SessionManager**: Focuses solely on browser session lifecycle and pooling
- **SiteManager**: Handles all site-specific data, runs, and scraping state
- Neither manager should directly call the other - coordination happens at the engine level

### Data Flow
1. Engine requests sessions from SessionManager
2. Engine requests site data and runs from SiteManager  
3. Engine uses core functions to match URLs to sessions
4. Engine coordinates updates back to both managers

### Why This Separation?
- **Single Responsibility**: Each manager has one clear domain
- **Flexibility**: Can swap session providers without affecting site logic
- **Testability**: Can test session management independently from site logic
- **Scalability**: Can optimize each manager independently

## Integration with Other Layers

### Using Drivers
Services should only use drivers for external operations:
```typescript
// Good - using driver
import { createBrowserbaseSession } from '../drivers/browser.js';

// Bad - using provider directly
import { createSession } from '../providers/browserbase.js'; // Never do this!
```

### Exposing to Engines
Services expose high-level operations to engines:
```typescript
// Engine uses services for orchestration
const sessions = await sessionManager.getActiveSessions();
const items = await siteManager.getPendingItems(runId);
const pairs = itemsToSessions(items, sessions, configs);
```

## Common Patterns

### Resource Pooling
```typescript
class SessionManager {
  private sessions: Map<string, Session> = new Map();
  
  async createSession(): Promise<string> {
    if (this.sessions.size >= this.sessionLimit) {
      throw new Error('Session limit reached');
    }
    // Create and pool session
  }
}
```

### State Caching
```typescript
class SiteManager {
  private sites: Map<string, SiteState> = new Map();
  
  async getSite(domain: string): SiteState | undefined {
    // Return from cache, load if needed
    return this.sites.get(domain);
  }
}
```

### Batch Operations
```typescript
async updateItemStatuses(updates: ItemUpdate[]): Promise<void> {
  const batchSize = 10;
  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize);
    await Promise.all(batch.map(this.updateItem));
  }
}
```