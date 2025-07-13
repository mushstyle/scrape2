# Claude Development Rules

## use bun
We use `bun` instead of `npm` and `node`.

## Testing
- DO NOT use cos.com for testing - has non-standard behavior
- Use amgbrand.com or blackseatribe.com for verify commands

## Code Style
- NEVER use `dotenv` - use Node.js 20+ native `.env` support
- NO console.log - use `logger.createContext()` instead
- NO `any` types unless absolutely necessary
- Follow existing patterns in neighboring files

## Commands
- Scripts via `bun run <name>` (see package.json)
- Verify commands: `bun run scrape verify [paginate|item]`
- All browser options after `--` (e.g., `-- --browser-type local`)

## Git Workflow
- NEVER commit to main - always create branch
- NEVER commit without explicit permission
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
- Check rules/ for patterns

## Common Fixes
- CLI flags: Initialize `options || {}` before custom flags
- Logger errors: Check method names (normal not info)
- Timeout issues: Increase with --timeout flag
