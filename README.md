# Scrape 2.0
A simplification of scraping processes from the `scrape-infra` repo.

## Architecture

This project includes clean, modular interfaces for web scraping:
- **Browser Module**: Creates Playwright browsers (Browserbase or local)
- **Proxy Module**: Manages proxy configurations
- **Cache Module**: In-memory request/response caching

## Credits

The caching implementation is inspired by the [browser-caching](https://github.com/mushstyle/browser-caching) project, which demonstrates elegant patterns for request interception and caching with Playwright.


