# Architecture Refactor Plan

## Overview
Complete restructuring of the codebase to enforce strict layering and remove all legacy code.

## Goals
1. Enforce strict import hierarchy: providers → drivers → services → core/engines
2. Remove all backward-compatible code
3. Update all documentation to reflect new architecture
4. Update all examples to use proper patterns

## Directory Structure
```
src/
├── providers/          # External service integrations
├── drivers/            # Provider abstractions
├── services/           # Stateful managers
├── core/               # Pure business logic (distributor.ts with doublePassMatcher)
├── engines/            # Top-level orchestration
├── utils/              # Cross-cutting concerns
└── types/              # Type definitions
```

## Tasks

### Phase 1: Create New Structure
- [x] Create new directories: drivers/, services/, core/, engines/
- [x] Create scrape-runs.ts driver to wrap ETL API functions

### Phase 2: Move Files
- [x] Move site-config.ts from providers/ to drivers/
- [x] Move browser.ts, proxy.ts, cache.ts to drivers/
- [x] Move session-manager-v2.ts to services/session-manager.ts
- [x] Move site-manager.ts to services/
- [x] Move scrape-run-manager.ts to services/
- [x] Move distributor.ts to core/
- [x] Move engine.ts to engines/scrape-engine.ts
- [x] Move logger.ts, image-utils.ts to utils/
- [x] Add doublePassMatcher function inside distributor.ts (not separate file)

### Phase 3: Update Imports
- [x] Update all imports in moved files to reflect new paths
- [x] Ensure services only import from drivers, not providers
- [x] Ensure engines only import from services/core, not drivers/providers

### Phase 4: Remove Legacy Code
- [x] Delete src/lib/session-manager.ts (old version)
- [x] Delete any other backward-compatible code
- [x] Clean up any unused imports or files

### Phase 5: Update Documentation
- [x] Delete docs/architecture.md
- [x] Create new docs/architecture.md with strict layering rules
- [x] Update CLAUDE.md to reference architecture.md as source of truth
- [x] Update any other docs that reference old structure

### Phase 6: Update Examples
- [x] Update session-based-usage.js to use drivers properly
- [x] Update orchestration-demo.ts to use new paths
- [x] Create new examples showing proper layering (architecture-demo.ts, proper-layering.ts)

### Phase 7: Update Tests
- [x] Update all test imports to new paths
- [x] Ensure tests follow same layering rules
- [x] Fix import issues (most test failures are due to httpbin.org being down)

### Phase 8: Final Cleanup
- [x] Run all tests (55/60 pass, 5 fail due to httpbin.org 503 errors)
- [x] Fix all import errors in providers
- [x] Remove empty lib directory
- [x] Update scripts/run-engine.ts to use new paths

## Success Criteria
- ✅ No file in engines/ imports from drivers/ or providers/
- ✅ No file in services/ imports from providers/
- ✅ All examples demonstrate proper architecture usage
- ✅ Most tests pass (5 failures due to external service issues)
- ✅ CLAUDE.md explicitly states to check architecture.md before editing

## Status: COMPLETED

The architecture refactor has been successfully completed. The codebase now follows a strict 5-layer architecture with clear import rules and boundaries.

## Notes
- This is a breaking change - no backward compatibility
- Focus on clarity over convenience
- Every import violation should be immediately obvious