import type { Page, Route } from 'playwright';
import type { CacheOptions, CacheStats, CacheEntry } from '../types/cache.js';

/**
 * In-memory request/response cache for Playwright pages
 */
export class RequestCache {
  private cache: Map<string, CacheEntry> = new Map();
  private stats = { hits: 0, misses: 0 };
  private totalSize = 0;
  private maxSizeBytes: number;
  private ttlSeconds?: number;

  constructor(options: CacheOptions) {
    this.maxSizeBytes = options.maxSizeBytes;
    this.ttlSeconds = options.ttlSeconds;
  }

  /**
   * Enable caching for a page
   */
  async enableForPage(page: Page): Promise<void> {
    await page.route('**/*', async (route: Route) => {
      const request = route.request();
      const method = request.method();
      const url = request.url();

      // Only cache GET requests
      if (method !== 'GET') {
        return route.continue();
      }

      // Skip requests with auth headers
      const headers = await request.allHeaders();
      if (headers.authorization || headers.cookie) {
        return route.continue();
      }

      // Check cache
      const cached = this.get(url);
      if (cached) {
        this.stats.hits++;
        return route.fulfill({
          status: cached.status,
          headers: cached.headers,
          body: cached.response
        });
      }

      // Cache miss - fetch and store
      this.stats.misses++;
      const response = await route.fetch();
      
      // Only cache successful responses
      if (response && response.status() >= 200 && response.status() < 300) {
        const body = await response.body();
        const headers: Record<string, string> = {};
        
        // Convert headers to plain object
        const responseHeaders = response.headers();
        for (const [key, value] of Object.entries(responseHeaders)) {
          headers[key] = value;
        }

        this.set(url, {
          url,
          response: body,
          headers,
          status: response.status(),
          timestamp: Date.now(),
          size: body.length
        });
      }

      return route.fulfill({
        response
      });
    });
  }


  /**
   * Get cached entry
   */
  private get(url: string): CacheEntry | null {
    const entry = this.cache.get(url);
    if (!entry) return null;

    // Check TTL if configured
    if (this.ttlSeconds) {
      const age = (Date.now() - entry.timestamp) / 1000;
      if (age > this.ttlSeconds) {
        this.cache.delete(url);
        this.totalSize -= entry.size;
        return null;
      }
    }

    return entry;
  }

  /**
   * Store entry in cache with LRU eviction
   */
  private set(url: string, entry: CacheEntry): void {
    // If entry exists, remove old size
    const existing = this.cache.get(url);
    if (existing) {
      this.totalSize -= existing.size;
    }

    // Add new entry
    this.cache.set(url, entry);
    this.totalSize += entry.size;

    // Evict oldest entries if over size limit
    while (this.totalSize > this.maxSizeBytes && this.cache.size > 0) {
      // Get first (oldest) entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        const removed = this.cache.get(firstKey);
        if (removed) {
          this.totalSize -= removed.size;
          this.cache.delete(firstKey);
        }
      }
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      sizeBytes: this.totalSize,
      itemCount: this.cache.size
    };
  }

  /**
   * Clear cache (all or by domain)
   */
  clear(domain?: string): void {
    if (!domain) {
      this.cache.clear();
      this.totalSize = 0;
    } else {
      // Clear entries matching domain
      for (const [url, entry] of this.cache.entries()) {
        if (url.includes(domain)) {
          this.cache.delete(url);
          this.totalSize -= entry.size;
        }
      }
    }
  }
}