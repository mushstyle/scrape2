# Scrape 2.0
A simplification of scraping processes from the `scrape-infra` repo.

## Requirements

- Node.js v20 or later (for native .env support)
- npm

## Setup

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

## Architecture

This project includes clean, modular interfaces for web scraping:
- **Browser Module**: Creates Playwright browsers (Browserbase or local)
- **Proxy Module**: Manages proxy configurations
- **Cache Module**: In-memory request/response caching with full proxy support
- **Engines**: High-level orchestrators for pagination and item scraping
- **Services**: SiteManager and SessionManager for state management
- **Distributor**: Intelligent URL-to-session matching

## CLI Commands

### Scraping Commands

```bash
# Paginate all sites (default: instanceLimit=10, maxPages=5)
npm run scrape paginate

# Paginate specific sites
npm run scrape paginate -- --sites=site1.com,site2.com

# Scrape items from all sites with pending items
npm run scrape items

# Scrape items from specific sites
npm run scrape items -- --sites=site1.com,site2.com

# Use local browser in headless mode
npm run scrape paginate -- --local-headless
npm run scrape items -- --local-headless

# Use local browser in headed mode (visible)
npm run scrape paginate -- --local-headed
npm run scrape items -- --local-headed

# Adjust limits
npm run scrape paginate -- --instance-limit=20 --max-pages=10
npm run scrape items -- --item-limit=200 --max-retries=3

# Skip saving (for testing)
npm run scrape paginate -- --no-save
npm run scrape items -- --no-save

# Custom cache settings
npm run scrape paginate -- --cache-size-mb=200 --cache-ttl-seconds=600

# Disable cache
npm run scrape paginate -- --disable-cache
```

### Verification Commands

```bash
# Verify pagination for a site
npm run scrape verify paginate amgbrand.com

# Verify item scraping
npm run scrape verify item https://example.com/product/123
```

### Site Management

```bash
# Manage sites
npm run sites:manage

# Get site configuration
npm run sites:config:get <domain>

# Set site configuration
npm run sites:config:set <domain> <config.json>
```

## Key Features

- **Double-pass matcher**: Efficient session allocation and reuse
- **Request caching**: Improves performance with intelligent caching
- **Error resilience**: Automatic retries for network errors
- **Resource optimization**: Minimal browser sessions, maximum throughput
- **Flexible browser options**: Browserbase or local Chrome/Chromium

## Documentation

- [Architecture](docs/architecture.md) - System design and layer hierarchy
- [Engines](docs/engines.md) - PaginateEngine and ScrapeItemEngine details
- [Rules](rules/) - Development guidelines and patterns

## Credits

The caching implementation is inspired by the [browser-caching](https://github.com/mushstyle/browser-caching) project, which demonstrates elegant patterns for request interception and caching with Playwright.


