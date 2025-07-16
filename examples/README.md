# Examples

This directory contains example scripts demonstrating various aspects of the scraper architecture.

## Running Examples

All examples can be run using npm scripts:

```bash
npm run example:<example-name> [args]
```

## Available Examples

### Architecture Demo
Demonstrates the proper layered architecture and import rules.
```bash
npm run example:architecture
```

### Proper Layering
Shows correct usage of the 5-layer architecture without violations.
```bash
npm run example:proper-layering
```

### Double-Pass Demo
Demonstrates the double-pass matcher algorithm for distributing URLs to sessions.
```bash
npm run example:double-pass
```

### Orchestration Demo
Shows how the orchestration engine works with sessions and sites.
```bash
npm run example:orchestration
```

### Site Info
Display information about configured sites and their scrapers.
```bash
npm run example:site-info [domain]
```

### Pagination
Demonstrates pagination scraping with retries and session management.
```bash
npm run example:pagination <domain>
# Example:
npm run example:pagination amgbrand.com
```

## Architecture Notes

These examples follow the strict layered architecture:
- **Engines** → Services → Drivers → Providers
- **Services** → Drivers → Providers  
- **Core** → Pure functions only (no imports from other layers)
- **Drivers** → Providers only
- **Providers** → External APIs only

Examples may occasionally violate these rules for demonstration purposes, but such violations are clearly documented in the code comments.