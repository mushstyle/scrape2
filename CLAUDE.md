# Claude Development Rules

## Architecture Overview
- **Session-based browser management** (see `docs/architecture.md`)
- **Providers** handle external services: `src/providers/` (browserbase, local-browser)
- **Sessions** created via provider's `createSession({ proxy })`
- **Browser contexts** from `createBrowserFromSession(session)`
- **NO backwards compatibility** - this is a clean-slate project

## use node
- We use Node.js v20+ with native `.env` support
- Use `npm` for package management
- Use `vitest` for testing instead of Bun test

## Rules to Follow
- `rules/types.md`: how to use and create
- `rules/plans.md`: how to create plans
- `rules/scrapers.md`: how to create scrapers
- `rules/providers.md`: how to create or access providers and external services/APIs

## Testing
- DO NOT use cos.com for testing - has non-standard behavior
- Use amgbrand.com or blackseatribe.com for verify commands
- `npm test` - runs tests once and exits
- `npm test:watch` - runs tests in watch mode

## Code Style
- NEVER use `dotenv` - use Node.js 20+ native `.env` support
- NO console.log - use `logger.createContext()` instead
- NO `any` types unless absolutely necessary
- Follow existing patterns in neighboring files

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

## Orchestration Patterns
- **ETL API**: Use `src/providers/etl-api.ts` for scrape run management
- **Distribution**: Use `itemsToSessions()` for pure functional item distribution
- **Session Pool**: Use `SessionManager` to manage browser session lifecycle
- **Run Management**: Use `ScrapeRunManager` for high-level run operations
- **Environment**: Requires `ETL_API_ENDPOINT` and `ETL_API_KEY` env vars
