import type { Page, Route } from 'playwright';
import type { CacheOptions, CacheStats, CacheEntry } from '../types/cache.js';

/**
 * In-memory request/response cache for Playwright pages
 */
export class RequestCache {
  private cache: Map<string, CacheEntry> = new Map();
  private stats = { hits: 0, misses: 0, bytesSaved: 0, bytesDownloaded: 0, blockedImages: 0 };
  private totalSize = 0;
  private maxSizeBytes: number;
  private ttlSeconds?: number;
  private blockImages: boolean;

  constructor(options: CacheOptions & { blockImages?: boolean }) {
    this.maxSizeBytes = options.maxSizeBytes;
    this.ttlSeconds = options.ttlSeconds;
    this.blockImages = options.blockImages ?? false;
  }

  /**
   * Enable caching for a page
   */
  async enableForPage(page: Page): Promise<void> {
    await page.route('**/*', async (route: Route) => {
      try {
        const request = route.request();
        const method = request.method();
        const url = request.url();
        const resourceType = request.resourceType();

        // First priority: Block images if enabled
        if (this.blockImages && (resourceType === 'image' || url.match(/\.(png|jpg|jpeg|gif|webp|svg|ico)(\?.*)?$/i))) {
          this.stats.blockedImages++;
          return await route.abort();
        }

        // Only cache GET requests
        if (method !== 'GET') {
          return await route.continue();
        }

        // Skip requests with auth headers
        const headers = await request.allHeaders();
        if (headers.authorization || headers.cookie) {
          return await route.continue();
        }

      // Check cache
      const cached = this.get(url);
      if (cached) {
        this.stats.hits++;
        this.stats.bytesSaved += cached.size;
        return await route.fulfill({
          status: cached.status,
          headers: cached.headers,
          body: cached.response
        });
      }

      // Cache miss - fetch and store
      this.stats.misses++;
      
      try {
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

          const size = body.length;
          this.stats.bytesDownloaded += size;

          this.set(url, {
            url,
            response: body,
            headers,
            status: response.status(),
            timestamp: Date.now(),
            size
          });
        }

        return await route.fulfill({
          response
        });
      
      } catch (error) {
        // For network errors (DNS, connection failures), continue without caching
        // This prevents crashes when external resources are unavailable
        return await route.continue();
      }
      } catch (error) {
        // If the page/context/browser is closed, just return silently
        // This prevents the process from crashing when pages are closed
        // The error will be: "Target page, context or browser has been closed"
        if (error instanceof Error && error.message.includes('Target page, context or browser has been closed')) {
          return;
        }
        // If route is already handled (by another handler), just return
        if (error instanceof Error && error.message.includes('Route is already handled')) {
          return;
        }
        // For other errors, try to continue without caching
        try {
          return await route.continue();
        } catch (continueError) {
          // If continue also fails, just return silently
          return;
        }
      }
    });
  }


  /**
   * Increment hit counter
   */
  incrementHits(): void {
    this.stats.hits++;
  }

  /**
   * Increment miss counter
   */
  incrementMisses(): void {
    this.stats.misses++;
  }

  /**
   * Get cached entry
   */
  get(url: string): CacheEntry | null {
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
  set(url: string, entry: CacheEntry): void {
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
  getStats(): CacheStats & { bytesSaved: number; bytesDownloaded: number; blockedImages: number } {
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      sizeBytes: this.totalSize,
      itemCount: this.cache.size,
      bytesSaved: this.stats.bytesSaved,
      bytesDownloaded: this.stats.bytesDownloaded,
      blockedImages: this.stats.blockedImages
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