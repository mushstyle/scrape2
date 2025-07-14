# Scraping Orchestration Plan

## Overview
A system for orchestrating web scraping by distributing work items across available browser sessions. The core is a pure function that handles the distribution logic, supported by managers that handle external interactions.

## Type Files to Create

### 1. `src/types/scrape-run.ts`
Types for scrape run management and ETL API integration.

```typescript
// Core item type
export interface ScrapeRunItem {
  url: string;
  done: boolean;
  failed?: boolean;
  invalid?: boolean;
  failedReason?: string | null;
}

// Main run type
export interface ScrapeRun {
  _id: string;
  domain: string;
  startTime: string;
  endTime: string | null;
  items: ScrapeRunItem[];
  createdAt: string;
  updatedAt: string;
}

// Metadata for tracking run progress
export interface ScrapeRunMetadata {
  started_at?: string;
  finished_at?: string | null;
  finished_count?: number;
  total_count?: number;
  failed_count?: number;
}

// API response types
export interface CreateScrapeRunResponse extends ScrapeRun {
  id?: string;  // Sometimes returned as 'id' instead of '_id'
  source?: string;
  status?: string;
  metadata?: ScrapeRunMetadata;
  created_at?: string;  // Alternative field name
}

export interface ListScrapeRunsResponse {
  data: ScrapeRun[];
  pagination: {
    currentPage: number;
    totalPages: number;
    totalItems: number;
    limit: number;
  };
}

// Request types
export interface CreateScrapeRunRequest {
  domain: string;
  source?: string;  // e.g., 'manual', 'scheduled'
  metadata?: {
    started_at: string;
  };
  items?: Array<{ url: string }>;
}

export interface UpdateScrapeRunItemRequest {
  updateItem: {
    url: string;
    changes: {
      done?: boolean;
      failed?: boolean;
      invalid?: boolean;
      failedReason?: string | null;
    };
  };
}

export interface FinalizeScrapeRunRequest {
  status: 'finished';
  endTime: string;
  metadata?: ScrapeRunMetadata;
}
```

### 2. `src/types/orchestration.ts`
Types for the orchestration system.

```typescript
import type { Session } from './session.js';
import type { ScrapeRunItem } from './scrape-run.js';

// Distribution types
export interface DistributionResult {
  session: Session;
  items: ScrapeRunItem[];
}

export interface SessionStats {
  sessionId: string;
  itemsProcessed: number;
  errors: number;
  uptime: number;
  currentLoad: number;
}

export interface ItemStats {
  total: number;
  pending: number;
  completed: number;
  failed: number;
  byDomain: Record<string, number>;
}

export type DistributionStrategy = 'round-robin' | 'domain-affinity' | 'least-loaded';

export interface DistributionOptions {
  strategy?: DistributionStrategy;
  maxItemsPerSession?: number;
  prioritizeDomains?: string[];
}

export interface SessionManagerOptions {
  maxSessions?: number;
  sessionTimeout?: number;
  provider?: 'browserbase' | 'local';
}
```

## Implementation Files to Create

### 1. `src/providers/etl-api.ts`
ETL API client for scrape run management.

```typescript
import type { 
  ScrapeRun,
  CreateScrapeRunRequest,
  CreateScrapeRunResponse,
  ListScrapeRunsResponse,
  UpdateScrapeRunItemRequest,
  FinalizeScrapeRunRequest,
  ScrapeRunMetadata
} from '../types/scrape-run.js';
import { logger } from '../lib/logger.js';

const log = logger.createContext('etl-api');

// Environment configuration
const ETL_API_ENDPOINT = process.env.ETL_API_ENDPOINT;
const ETL_API_KEY = process.env.ETL_API_KEY;

// API client functions
export async function createScrapeRun(request: CreateScrapeRunRequest): Promise<CreateScrapeRunResponse>
export async function fetchScrapeRun(runId: string): Promise<CreateScrapeRunResponse>
export async function listScrapeRuns(params?: {
  domain?: string;
  status?: string;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}): Promise<ListScrapeRunsResponse>
export async function updateScrapeRunItem(runId: string, update: UpdateScrapeRunItemRequest): Promise<void>
export async function finalizeScrapeRun(runId: string, request: FinalizeScrapeRunRequest): Promise<void>
export async function getLatestRunForDomain(domain: string): Promise<ScrapeRun | null>

// Helper functions
function normalizeRunResponse(response: any): CreateScrapeRunResponse
function buildApiUrl(path: string, params?: Record<string, string>): string
```

**Implementation Details:**
- Centralized API key and endpoint management
- Consistent error handling and response normalization
- Handle field name variations (_id vs id, createdAt vs created_at)
- Proper TypeScript types for all operations
- Logging for debugging

### 2. `src/lib/distributor.ts`
Pure functional core for distributing items to sessions.

```typescript
import type { Session } from '../types/session.js';
import type { ScrapeRunItem } from '../types/scrape-run.js';
import type { 
  DistributionResult, 
  DistributionOptions 
} from '../types/orchestration.js';

// Main function
export function itemsToSessions(
  items: ScrapeRunItem[],
  sessions: Session[],
  options?: DistributionOptions
): DistributionResult[]
```

**Implementation Details:**
- Returns exactly `sessions.length` results (one per session)
- Each session gets a subset of items based on the strategy
- Filters out already completed items (done === true)
- Strategies:
  - `round-robin`: Distribute items evenly across sessions
  - `domain-affinity`: Keep items from the same domain together
  - `least-loaded`: Balance based on current session load
- Empty items array if not enough items for all sessions

### 3. `src/lib/session-manager.ts`
Manages browser sessions (non-pure, handles external state).

```typescript
import type { Session, SessionOptions } from '../types/session.js';
import type { SessionManagerOptions, SessionStats } from '../types/orchestration.js';

// Functions
export async function getActiveSessions(): Promise<Session[]>
export async function createSession(options?: SessionOptions): Promise<Session>
export async function destroySession(sessionId: string): Promise<void>
export async function getSessionStats(sessionId: string): Promise<SessionStats>
export async function refreshSessions(): Promise<Session[]>
```

**Responsibilities:**
- Create/destroy browser sessions via providers
- Track active sessions
- Monitor session health/timeouts
- Handle session pooling
- Integrate with src/providers/browserbase.ts and src/providers/local-browser.ts

### 4. `src/lib/scrape-run-manager.ts`
Manages scrape runs and their lifecycle.

```typescript
import type { 
  ScrapeRun,
  ScrapeRunItem,
  CreateScrapeRunRequest
} from '../types/scrape-run.js';
import * as etlApi from '../providers/etl-api.js';

// Functions
export async function createRun(domain: string, urls?: string[]): Promise<ScrapeRun>
export async function getActiveRun(domain: string): Promise<ScrapeRun | null>
export async function getPendingItems(runId: string): Promise<ScrapeRunItem[]>
export async function updateItemStatus(
  runId: string, 
  item: ScrapeRunItem,
  status: { done?: boolean; failed?: boolean; invalid?: boolean; failedReason?: string }
): Promise<void>
export async function finalizeRun(runId: string): Promise<void>
export async function getRunStats(runId: string): Promise<{
  total: number;
  completed: number;
  failed: number;
  pending: number;
}>
```

**Responsibilities:**
- Create and manage scrape runs via ETL API
- Track item completion status
- Provide pending items for distribution
- Calculate run statistics
- Handle run finalization

## Usage Example

```typescript
// In a higher-level orchestrator
import { itemsToSessions } from './lib/distributor.js';
import { getActiveSessions } from './lib/session-manager.js';
import { getActiveRun, getPendingItems, updateItemStatus } from './lib/scrape-run-manager.js';

async function orchestrateScraping(domain: string) {
  // Get or create active run
  const run = await getActiveRun(domain) || await createRun(domain);
  
  // Get sessions and pending items
  const sessions = await getActiveSessions();
  const pendingItems = await getPendingItems(run._id);
  
  // Pure function distribution
  const distribution = itemsToSessions(pendingItems, sessions, {
    strategy: 'domain-affinity',
    maxItemsPerSession: 50
  });
  
  // Execute scraping tasks
  for (const { session, items } of distribution) {
    for (const item of items) {
      try {
        // Scrape item with session
        await scrapeItem(session, item.url);
        await updateItemStatus(run._id, item, { done: true });
      } catch (error) {
        await updateItemStatus(run._id, item, { 
          failed: true, 
          failedReason: error.message 
        });
      }
    }
  }
  
  // Finalize if all done
  const stats = await getRunStats(run._id);
  if (stats.pending === 0) {
    await finalizeRun(run._id);
  }
}
```

## Testing Strategy

1. **Distributor Tests** (Pure function tests):
   - Test each strategy with mock ScrapeRunItems
   - Edge cases: empty items, empty sessions, single session
   - Verify completed items are filtered out
   - Domain affinity grouping

2. **ETL API Tests** (Integration tests):
   - Mock HTTP responses
   - Test field normalization
   - Error handling for network failures
   - API key and endpoint configuration

3. **Manager Tests** (Integration tests):
   - Mock ETL API responses
   - Test run lifecycle
   - Item state transitions
   - Concurrent run handling

## Future Considerations

- Add metrics/monitoring to managers
- Implement caching for run data
- Add retry logic for failed items
- Session warmup/cooldown strategies
- Batch API updates for performance
- WebSocket support for real-time status updates