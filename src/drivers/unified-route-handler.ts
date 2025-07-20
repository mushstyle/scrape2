import type { Route } from 'playwright';
import { RequestCache } from './cache.js';

/**
 * Unified route handler that combines caching and image blocking
 * This prevents conflicts between multiple route handlers
 */
export class UnifiedRouteHandler {
  private cache?: RequestCache;
  private blockImages: boolean;

  constructor(options: {
    cache?: RequestCache;
    blockImages?: boolean;
  }) {
    this.cache = options.cache;
    this.blockImages = options.blockImages ?? true;
  }

  async handle(route: Route): Promise<void> {
    try {
      const request = route.request();
      const method = request.method();
      const url = request.url();
      const resourceType = request.resourceType();

      // First priority: Block images if requested
      if (this.blockImages && resourceType === 'image') {
        await route.abort();
        return;
      }

      // Second priority: Handle caching for GET requests
      if (this.cache && method === 'GET') {
        // Skip requests with auth headers
        const headers = await request.allHeaders();
        if (!headers.authorization && !headers.cookie) {
          // Check cache
          const cached = this.cache.get(url);
          if (cached) {
            this.cache.incrementHits();
            await route.fulfill({
              status: cached.status,
              headers: cached.headers,
              body: cached.response
            });
            return;
          }

          // Cache miss - fetch and store
          this.cache.incrementMisses();
          
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

              this.cache.set(url, {
                url,
                response: body,
                headers,
                status: response.status(),
                timestamp: Date.now(),
                size: body.length
              });
            }

            await route.fulfill({ response });
            return;
          } catch (error) {
            // Fall through to continue on network errors
          }
        }
      }

      // Default: Continue with normal request
      await route.continue();
      
    } catch (error: any) {
      // Handle various error cases
      if (error.message?.includes('Route is already handled')) {
        // Silently ignore - another handler got to it first
        return;
      }
      
      if (error.message?.includes('Target page, context or browser has been closed')) {
        // Page/context closed, nothing to do
        return;
      }

      // Log unexpected errors but don't crash
      console.error('Unified route handler error:', error.message);
    }
  }
}