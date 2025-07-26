# Architecture Overview

## Strict Layered Architecture

This codebase follows a strict layered architecture where each layer can only import from specific other layers. This ensures clean separation of concerns and prevents architectural violations.

## The Five Layers

### 1. Providers (External Integrations)
Direct integrations with external services and APIs. These are the only components that make external calls.

### 2. Drivers (Abstractions) 
Thin wrappers around providers that abstract implementation details and provide a consistent interface.

### 3. Services (Stateful Managers)
Stateful components that manage resources, coordinate operations, and maintain domain state.

### 4. Core (Pure Business Logic)
Pure functions containing business logic with no side effects or external dependencies.

### 5. Engines (Orchestration)
Top-level components that orchestrate complex workflows using services and core logic.

## Import Rules - The Foundation of Our Architecture

### Dependency Flow
Dependencies must flow in one direction only: **Engines → Services → Drivers → Providers**

### Layer Import Rules

#### Level 1: Providers
- **Can import**: utilities, types
- **Cannot import**: ANY other application code
- **Why**: Providers are the foundation and must not depend on higher layers

#### Level 2: Drivers  
- **Can import**: providers, utilities, types
- **Cannot import**: services, core, engines
- **Why**: Drivers abstract providers but don't know about business logic

#### Level 3: Services
- **Can import**: drivers, utilities, types
- **Cannot import**: providers, core, engines
- **Must**: Use drivers for ALL external access (never providers directly)
- **Why**: Services coordinate through drivers, maintaining abstraction

#### Level 4: Core
- **Can import**: utilities, types
- **Cannot import**: providers, drivers, services, engines
- **Must**: Contain ONLY pure functions (no side effects)
- **Why**: Core logic must be testable and reusable without dependencies

#### Level 5: Engines
- **Can import**: services, core, utilities, types
- **Cannot import**: providers, drivers
- **Must**: Use services for ALL stateful operations
- **Why**: Engines orchestrate but don't implement low-level details

### Special Cases

#### Examples
- **Default**: Import from services, core, utilities, types
- **Exception**: When demonstrating a specific layer, may import that layer
- **Why**: Examples should show typical usage patterns

#### Tests
- **Rule**: Test files follow the same import rules as the code they test
- **Why**: Tests must respect architecture to catch violations

### Correct Patterns

```typescript
// ✅ Engine uses services for orchestration
import { SessionManager } from '../services/session-manager.js';
import { calculateOptimalDistribution } from '../core/algorithms.js';

// ✅ Service uses drivers for external access
import { createRemoteSession } from '../drivers/browser.js';

// ✅ Driver uses providers for implementation
import { connectToAPI } from '../providers/external-api.js';

// ✅ Core contains pure business logic
export function calculateScore(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.value, 0);
}
```

### Anti-Patterns to Avoid

```typescript
// ❌ Engine bypassing service layer
import { fetchDataDirectly } from '../drivers/data.js';

// ❌ Service bypassing driver abstraction  
import { makeAPICall } from '../providers/api.js';

// ❌ Core depending on stateful services
import { SessionManager } from '../services/session-manager.js';

// ❌ Lower layer depending on higher layer
import { Engine } from '../engines/main.js';
```

## Key Architectural Patterns

### Resource Management Pattern

**Flow**: External Resource → Provider → Driver → Service → Engine

1. **Providers** create connections to external resources
2. **Drivers** wrap provider functions with consistent interfaces
3. **Services** manage resource lifecycle and state
4. **Engines** orchestrate resource usage for business goals

### State Management Pattern

**Services as State Owners**:
- Services maintain all stateful data
- Services provide high-level APIs for state access
- Services handle state synchronization with external systems
- Engines coordinate but never own state

### Pure Logic Pattern

**Core as Pure Functions**:
- Core functions take inputs and return outputs
- No side effects or external dependencies
- Easily testable with simple unit tests
- Reusable across different contexts

## Design Principles

### 1. Separation of Concerns
Each layer has a single, well-defined responsibility. Mixing concerns across layers is forbidden.

### 2. Dependency Inversion
Higher layers define interfaces they need, lower layers implement them. Dependencies point inward.

### 3. Abstraction Layers
Each layer provides abstractions that hide implementation details from higher layers.

### 4. Testability First
Architecture enables testing at every layer with appropriate mocking boundaries.

### 5. No Leaky Abstractions
Implementation details must not leak across layer boundaries. Change internals without affecting consumers.

## Implementation Guidelines

### Creating New Components

1. **Identify the Layer**
   - External integration? → Provider
   - Abstracting a provider? → Driver
   - Managing state/resources? → Service
   - Pure business logic? → Core
   - Orchestrating workflow? → Engine

2. **Define Interfaces First**
   - What does this component expose?
   - What dependencies does it need?
   - What types flow in and out?

3. **Respect Layer Boundaries**
   - Only import from allowed layers
   - Never bypass abstraction layers
   - Keep implementation details private

### Testing Strategy

1. **Unit Tests**
   - Providers: Mock external APIs
   - Drivers: Mock providers
   - Services: Mock drivers
   - Core: Pure functions, no mocks needed
   - Engines: Mock services

2. **Integration Tests**
   - Test layer combinations
   - Verify contracts between layers
   - Ensure proper error propagation

### Code Review Checklist

- [ ] Imports follow layer rules
- [ ] No abstraction leakage
- [ ] Proper error handling
- [ ] State managed by services
- [ ] Business logic in core
- [ ] External calls in providers only

## Maintaining the Architecture

### Adding New Features

1. **Start from the top**: What does the engine need?
2. **Work downward**: What services support this?
3. **Identify externals**: What external resources are required?
4. **Build upward**: Implement providers → drivers → services
5. **Integrate**: Connect everything in the engine

### Refactoring Safely

1. **Never skip layers** when moving functionality
2. **Extract to appropriate layer** based on responsibility
3. **Update tests** to match new structure
4. **Verify imports** still follow rules

### Common Pitfalls

1. **"Just this once"** - Breaking layer rules for convenience
2. **Fat services** - Services doing too much instead of delegating
3. **Smart drivers** - Drivers containing business logic
4. **Stateful core** - Core functions with side effects
5. **Orchestrating services** - Services calling other services

### Benefits of Discipline

- **Predictable codebase** - Know where to find functionality
- **Safe refactoring** - Changes don't cascade unexpectedly  
- **Easy testing** - Clear mocking boundaries
- **Parallel development** - Teams can work on different layers
- **Onboarding speed** - New developers understand structure quickly

## Browser and Cache Architecture

### Browser Creation Flow
The correct flow for creating browsers is: **Provider → Session → Browser (via browser.ts driver)**

1. **Providers** create platform-specific sessions (Browserbase, local)
2. **SessionManager** (service) manages session lifecycle
3. **browser.ts** (driver) creates Playwright browser from session
4. **Never** call playwright's chromium.launch() directly

### Request Caching and Image Blocking
The RequestCache (driver) handles both caching and image blocking:

- **Single Route Handler**: Avoids conflicts between multiple handlers
- **Image Blocking First**: Images blocked before cache checks
- **Bandwidth Savings**: 85%+ reduction with image blocking enabled
- **Default Behavior**: Images blocked by default, disable with `--no-block-images`

```typescript
// ✅ Correct: Cache with integrated image blocking
const cache = new RequestCache({
  maxSizeBytes: 100 * 1024 * 1024,
  blockImages: true  // Images blocked at cache layer
});

// ❌ Wrong: Separate image blocking (causes conflicts)
await context.route('**/*.{png,jpg}', route => route.abort());
```