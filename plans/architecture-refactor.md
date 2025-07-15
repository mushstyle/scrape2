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
├── core/               # Pure business logic
├── engines/            # Top-level orchestration
├── utils/              # Cross-cutting concerns
└── types/              # Type definitions
```

## Tasks

### Phase 1: Create New Structure
- [ ] Create new directories: drivers/, services/, core/, engines/
- [ ] Create scrape-runs.ts driver to wrap ETL API functions

### Phase 2: Move Files
- [ ] Move site-config.ts from providers/ to drivers/
- [ ] Move browser.ts, proxy.ts, cache.ts to drivers/
- [ ] Move session-manager-v2.ts to services/session-manager.ts
- [ ] Move site-manager.ts to services/
- [ ] Move scrape-run-manager.ts to services/
- [ ] Move distributor.ts to core/
- [ ] Move engine.ts to engines/scrape-engine.ts
- [ ] Move logger.ts, image-utils.ts to utils/

### Phase 3: Update Imports
- [ ] Update all imports in moved files to reflect new paths
- [ ] Ensure services only import from drivers, not providers
- [ ] Ensure engines only import from services/core, not drivers/providers

### Phase 4: Remove Legacy Code
- [ ] Delete src/lib/session-manager.ts (old version)
- [ ] Delete any other backward-compatible code
- [ ] Clean up any unused imports or files

### Phase 5: Update Documentation
- [ ] Delete docs/architecture.md
- [ ] Create new docs/architecture.md with strict layering rules
- [ ] Update CLAUDE.md to reference architecture.md as source of truth
- [ ] Update any other docs that reference old structure

### Phase 6: Update Examples
- [ ] Update session-based-usage.js to use services properly
- [ ] Update orchestration-demo.ts to use new paths
- [ ] Create new example showing proper layering

### Phase 7: Update Tests
- [ ] Update all test imports to new paths
- [ ] Ensure tests follow same layering rules
- [ ] Fix any broken tests from refactor

### Phase 8: Final Cleanup
- [ ] Run all tests to ensure nothing broken
- [ ] Run examples to verify they work
- [ ] Remove any empty directories
- [ ] Update package.json scripts if needed

## Success Criteria
- No file in engines/ imports from drivers/ or providers/
- No file in services/ imports from providers/
- All examples demonstrate proper architecture usage
- All tests pass
- CLAUDE.md explicitly states to check architecture.md before editing

## Notes
- This is a breaking change - no backward compatibility
- Focus on clarity over convenience
- Every import violation should be immediately obvious