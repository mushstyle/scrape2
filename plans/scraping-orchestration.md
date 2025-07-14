# Scraping Orchestration Plan

## Overview
A system for orchestrating web scraping by distributing work items across available browser sessions. The core is a pure function that handles the distribution logic, supported by managers that handle external interactions.

## Type Files to Create

### 1. `src/types/orchestration.ts`
Shared types for the orchestration system.

```typescript
import type { Session } from './session.js';

export interface ItemToScrape {
  url: string;
  domain: string;
  // Additional metadata to be added over time
}

export interface DistributionResult {
  session: Session;
  items: ItemToScrape[];
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

export interface ItemManagerOptions {
  limit?: number;
  domain?: string;
  since?: Date;
}
```

## Implementation Files to Create

### 1. `src/lib/distributor.ts`
Pure functional core for distributing items to sessions.

```typescript
import type { Session } from '../types/session.js';
import type { 
  ItemToScrape, 
  DistributionResult, 
  DistributionOptions 
} from '../types/orchestration.js';

// Main function
export function itemsToSessions(
  items: ItemToScrape[],
  sessions: Session[],
  options?: DistributionOptions
): DistributionResult[]
```

**Implementation Details:**
- Returns exactly `sessions.length` results (one per session)
- Each session gets a subset of items based on the strategy
- Strategies:
  - `round-robin`: Distribute items evenly across sessions
  - `domain-affinity`: Keep items from the same domain together
  - `least-loaded`: Balance based on current session load
- Empty items array if not enough items for all sessions

### 2. `src/lib/session-manager.ts`
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

### 3. `src/lib/item-manager.ts`
Manages items to be scraped (non-pure, handles external state).

```typescript
import type { 
  ItemToScrape, 
  ItemStats, 
  ItemManagerOptions 
} from '../types/orchestration.js';

// Functions
export async function getItemsToScrape(options?: ItemManagerOptions): Promise<ItemToScrape[]>
export async function markItemScraped(item: ItemToScrape): Promise<void>
export async function markItemFailed(item: ItemToScrape, error: Error): Promise<void>
export async function getItemStats(): Promise<ItemStats>
export async function getPendingItemsByDomain(): Promise<Map<string, ItemToScrape[]>>
```

**Responsibilities:**
- Fetch items from database/API
- Track scraping status
- Handle failed items
- Provide domain-based grouping
- Integrate with ETL API or local database

## Usage Example

```typescript
// In a higher-level orchestrator
import { itemsToSessions } from './lib/distributor.js';
import { getActiveSessions } from './lib/session-manager.js';
import { getItemsToScrape } from './lib/item-manager.js';

async function orchestrateScraping() {
  // Get data from managers
  const sessions = await getActiveSessions();
  const items = await getItemsToScrape({ limit: 1000 });
  
  // Pure function distribution
  const distribution = itemsToSessions(items, sessions, {
    strategy: 'domain-affinity',
    maxItemsPerSession: 50
  });
  
  // Execute scraping tasks
  for (const { session, items } of distribution) {
    // Process items with session...
  }
}
```

## Testing Strategy

1. **Distributor Tests** (Pure function tests):
   - Test each strategy with mock data
   - Edge cases: empty items, empty sessions, single session
   - Verify distribution fairness
   - Domain affinity grouping

2. **Manager Tests** (Integration tests):
   - Mock external APIs/databases
   - Test session lifecycle
   - Test item state transitions
   - Error handling

## Future Considerations

- Add metrics/monitoring to managers
- Consider caching in managers
- Add retry logic to item-manager
- Session warmup/cooldown strategies
- Load balancing based on session performance