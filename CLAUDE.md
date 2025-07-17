# Claude Development Rules

## CRITICAL: Architecture Rules
**BEFORE ANY EDITING, READ `docs/architecture.md`** - This is the source of truth for:
- Directory structure and import hierarchy
- Which layers can import from which other layers
- How to properly create browsers and sessions
- Examples of correct and incorrect patterns

## Architecture Summary
- **Strict 5-layer hierarchy**: providers → drivers → services → core/engines
- **NEVER skip layers** - e.g., services MUST use drivers, not providers
- **Browser creation**: Provider → Session → Browser (via browser.ts driver)
- **NO backwards compatibility** - this is a clean-slate project

## CRITICAL: Browser Creation Rules
- **NEVER create browsers without `browser.ts`** - This is the ONLY way to create browsers
- **NEVER call playwright's chromium.launch() or connect() directly**
- **ALWAYS use `createBrowserFromSession()` from `src/drivers/browser.ts`**
- **SessionManager MUST store actual Session objects, not just IDs**
- **The flow is: Provider → Session → Browser (via browser.ts)**

## use node
- We use Node.js v20+ with native `.env` support
- Use `npm` for package management
- Use `vitest` for testing instead of Bun test

## Rules to Follow
- `rules/testing.md`: how to test
- `rules/types.md`: how to use and create types
- `rules/plans.md`: how to create plans
- `rules/scrapers.md`: how to create scrapers
- `rules/providers.md`: how to create or access providers and external services/APIs
- `rules/examples.md`: how to create examples

## Testing
- DO NOT use cos.com for testing - has non-standard behavior
- Use amgbrand.com or blackseatribe.com for verify commands
- `npm test` - runs tests once and exits
- `npm run test:watch` - runs tests in watch mode

## Code Style
- NEVER use `dotenv` - use Node.js 20+ native `.env` support
- NO console.log - use `logger.createContext()` instead
- NO `any` types unless absolutely necessary
- Follow existing patterns in neighboring files
- CLI parameters should match internal variable names (e.g., `instanceLimit` → `--instance-limit`)

## Commands
- Scripts via `npm run <name>` (see package.json)
- Verify commands: `npm run scrape verify [paginate|item]`
- All browser options after `--` (e.g., `-- --browser-type local`)

## Git Workflow
- NEVER commit to main - always create branch
- NEVER commit without explicit permission
- Create the PR yourself using current branch, if no PR exists for current branch
- PR merge = `gh pr create` → `gh pr merge --squash` → `git pull`

## Browser/Proxy
- Default: Browserbase with datacenter proxy
- Image blocking ON by default
- Session timeout: 1 minute (override with --session-timeout)
- Config: db/proxies.json

## Logging
- Use logger methods: normal, error, debug, verbose
- Context logger: `const log = logger.createContext('module-name')`
- No warn() or info() - use error() or normal()

## Documentation
- Keep concise - avoid duplication
- Update docs when changing functionality

## Common Fixes
- CLI flags: Initialize `options || {}` before custom flags
- Logger errors: Check method names (normal not info)
- Timeout issues: Increase with --timeout flag