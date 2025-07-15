# Architecture Overview

## Strict Layered Architecture

This codebase follows a strict layered architecture where each layer can only import from specific other layers. This ensures clean separation of concerns and prevents architectural violations.

## Directory Structure

```
src/
├── providers/          # External service integrations (Level 1)
│   ├── browserbase.ts      # Browserbase API integration
│   ├── local-browser.ts    # Local Chrome browser provider
│   ├── etl-api.ts          # ETL API for scrape runs and sites
│   └── local-db.ts         # Local JSON file access
│
├── drivers/            # Provider abstractions (Level 2)
│   ├── browser.ts          # Browser session creation and management
│   ├── proxy.ts            # Proxy configuration management
│   ├── site-config.ts      # Site configuration retrieval
│   ├── cache.ts            # Request/response caching
│   └── scrape-runs.ts      # Scrape run operations wrapper
│
├── services/           # Stateful managers (Level 3)
│   ├── session-manager.ts      # Browser session pool management
│   ├── site-manager.ts         # Site configuration and state
│
├── core/               # Pure business logic (Level 4)
│   └── distributor.ts          # URL-session matching algorithms
│                               # Including doublePassMatcher function
│
├── engines/            # Top-level orchestration (Level 5)
│   └── scrape-engine.ts        # Main scraping engine
│
├── utils/              # Cross-cutting utilities
│   ├── logger.ts               # Logging utilities
│   └── image-utils.ts          # Image processing utilities
│
└── types/              # TypeScript type definitions
```

## CRITICAL: Import Rules

### Strict Hierarchy (MUST BE FOLLOWED)

1. **Providers** (Level 1)
   - Can import: `utils/*`, `types/*`
   - Cannot import: ANY other src files

2. **Drivers** (Level 2)
   - Can import: `providers/*`, `utils/*`, `types/*`
   - Cannot import: `services/*`, `core/*`, `engines/*`

3. **Services** (Level 3)
   - Can import: `drivers/*`, `utils/*`, `types/*`
   - Cannot import: `providers/*`, `core/*`, `engines/*`
   - MUST use drivers for ALL external service access

4. **Core** (Level 4)
   - Can import: `utils/*`, `types/*`
   - Cannot import: `providers/*`, `drivers/*`, `services/*`, `engines/*`
   - Contains ONLY pure functions (no side effects)

5. **Engines** (Level 5)
   - Can import: `services/*`, `core/*`, `utils/*`, `types/*`
   - Cannot import: `providers/*`, `drivers/*`
   - MUST use services for ALL stateful operations

6. **Examples** Not a layer, but a directory that contains examples of how to use the code.
  - Can import services/*, core/*, utils/*, types/*
  - Only exception: if an example is meant to demonstrate how to use a specific layer, it can import that layer directly.

### Examples of Correct Usage

```typescript
// ✅ CORRECT: Engine uses services
// engines/scrape-engine.ts
import { SessionManager } from '../services/session-manager.js';
import { itemsToSessions } from '../core/distributor.js';

// ✅ CORRECT: Service uses drivers
// services/session-manager.ts
import { createBrowserbaseSession } from '../drivers/browser.js';

// ✅ CORRECT: Driver uses providers
// drivers/browser.ts
import { createSession } from '../providers/browserbase.js';
```

### Examples of Violations

```typescript
// ❌ WRONG: Engine importing driver directly
// engines/scrape-engine.ts
import { createBrowserFromSession } from '../drivers/browser.js';

// ❌ WRONG: Service importing provider directly
// services/session-manager.ts
import { createSession } from '../providers/browserbase.js';

// ❌ WRONG: Core importing service
// core/distributor.ts
import { SessionManager } from '../services/session-manager.js';
```

## Browser Session Architecture

### The Only Correct Flow

**Provider → Session → Browser (via browser.ts)**

1. **Providers** create Session objects with connection information
2. **Drivers** wrap provider functions and expose them to services
3. **Services** manage Session objects (NOT just IDs)
4. **Only browser.ts** creates browser instances from Sessions

### CRITICAL: Session Management

The SessionManager MUST:
- Store actual Session objects, not just IDs
- Return Session[] from getActiveSessions()
- Pass Session objects to browser.ts for browser creation

### NEVER Do This

- ❌ Create browsers directly with Playwright
- ❌ Call chromium.launch() or chromium.connect()
- ❌ Store only session IDs in SessionManager
- ❌ Bypass the browser.ts driver

## Core Components

### Providers (External Services)
- **browserbase.ts**: Creates remote browser sessions via API
- **local-browser.ts**: Creates local Chrome browser sessions
- **etl-api.ts**: Manages scrape runs, sites, and items
- **local-db.ts**: Reads local JSON configuration files

### Drivers (Abstractions)
- **browser.ts**: Creates browsers from sessions, manages contexts
- **proxy.ts**: Loads and formats proxy configurations
- **site-config.ts**: Retrieves site scraping configurations
- **cache.ts**: In-memory request/response caching
- **scrape-runs.ts**: Wraps ETL API operations

### Services (Stateful Managers)
- **session-manager.ts**: Manages pool of browser sessions
- **site-manager.ts**: Central hub for all site-related operations:
  - Site configurations and state
  - Scrape run creation and management
  - URL retry tracking
  - Item status updates and data uploads
  - Pending (uncommitted) runs

### Core (Business Logic)
- **distributor.ts**: Contains pure functions for URL-session matching
  - `itemsToSessions()`: Linear 1:1 URL-session matching
  - `doublePassMatcher()`: Two-pass matching algorithm

### Engines (Orchestration)
- **scrape-engine.ts**: Orchestrates scraping operations using services

## Key Principles

1. **Separation of Concerns**: Each layer has a specific responsibility
2. **Dependency Inversion**: Higher layers define interfaces, lower layers implement
3. **No Leaky Abstractions**: Implementation details don't leak across layers
4. **Testability**: Each layer can be tested independently
5. **Type Safety**: Full TypeScript support throughout

## Common Patterns

### Creating a Browser Session

```typescript
// In a service (e.g., session-manager.ts)
import { createBrowserbaseSession } from '../drivers/browser.js';

const session = await createBrowserbaseSession({ proxy });
// Store the actual Session object, not just an ID!
```

### Using Sessions to Create Browsers

```typescript
// In an engine or high-level code
import { createBrowserFromSession } from '../drivers/browser.js';

const { browser, createContext, cleanup } = await createBrowserFromSession(session);
const context = await createContext();
const page = await context.newPage();
// ... do work ...
await cleanup();
```

### Distributing Work

```typescript
// In an engine
import { itemsToSessions, doublePassMatcher } from '../core/distributor.js';

// Simple distribution
const pairs = itemsToSessions(items, sessions, siteConfigs);

// Or use double-pass matching
const { firstPassMatched, excessSessions, finalMatched } = 
  doublePassMatcher(items, initialSessions, finalSessions, siteConfigs);
```

## Benefits of This Architecture

1. **Clear Boundaries**: Violations are immediately obvious
2. **Maintainability**: Changes are isolated to specific layers
3. **Scalability**: New features fit naturally into the hierarchy
4. **Reliability**: Reduced coupling means fewer cascading failures
5. **Onboarding**: New developers quickly understand the structure