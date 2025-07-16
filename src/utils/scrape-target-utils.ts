import type { ScrapeTarget } from '../types/scrape-target.js';

/**
 * Convert URLs to ScrapeTarget format
 * @param urls - Array of URL strings
 * @returns Array of ScrapeTarget objects with done/failed/invalid set to false
 */
export function urlsToScrapeTargets(urls: string[]): ScrapeTarget[] {
  return urls.map(url => ({
    url,
    done: false,
    failed: false,
    invalid: false
  }));
}

/**
 * Convert a single URL to ScrapeTarget format
 * @param url - URL string
 * @returns ScrapeTarget object with done/failed/invalid set to false
 */
export function urlToScrapeTarget(url: string): ScrapeTarget {
  return {
    url,
    done: false,
    failed: false,
    invalid: false
  };
}

/**
 * Filter ScrapeTargets to get only pending (not done) targets
 * @param targets - Array of ScrapeTarget objects
 * @returns Array of pending ScrapeTarget objects
 */
export function getPendingTargets(targets: ScrapeTarget[]): ScrapeTarget[] {
  return targets.filter(target => !target.done);
}

/**
 * Mark a ScrapeTarget as failed with optional reason
 * @param target - ScrapeTarget to update
 * @param reason - Optional failure reason
 * @returns Updated ScrapeTarget
 */
export function markTargetFailed(target: ScrapeTarget, reason?: string): ScrapeTarget {
  return {
    ...target,
    failed: true,
    failReason: reason,
    updated_at: new Date().toISOString()
  };
}