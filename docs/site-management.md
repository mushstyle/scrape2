# Site Configuration Management

## Interactive CLI Tool

We've added an interactive CLI tool for managing site configurations, particularly start pages.

### Usage

```bash
npm run sites:manage
```

### Features

1. **Add start pages** - Add new URLs without removing existing ones
2. **Replace all start pages** - Replace entire list with new URLs
3. **Remove specific start pages** - Remove selected URLs from the list
4. **View current start pages** - Display current configuration

### Architecture Notes

- The tool is in `src/scripts/manage-sites.ts`
- It directly calls the site-config driver (allowed as scripts are top-layer)
- Updates are persisted to the ETL API immediately
- Changes affect all future scraping operations

### Example Workflow

```
1. Run: npm run sites:manage
2. Select option 1 (Add start pages)
3. Choose a site from the list
4. Enter new URLs (comma or newline separated)
5. Confirm the changes
```

### API Methods Added

The site-config driver now includes:
- `addStartPages(domain, urls)` - Add URLs (avoids duplicates)
- `replaceStartPages(domain, urls)` - Replace all URLs
- `removeStartPages(domain, urls)` - Remove specific URLs

These methods handle API communication and error handling internally.