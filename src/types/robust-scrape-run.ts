/**
 * Types for robust scrape run management with partial pagination state
 */

export interface PaginationState {
  startPageUrl: string;
  collectedUrls: string[];
  failureCount: number;
  failureHistory: Array<{
    timestamp: Date;
    proxy: string;
    error: string;
  }>;
  completed: boolean; // Explicitly track if pagination ran to completion
}

export interface PartialScrapeRun {
  siteId: string;
  paginationStates: Map<string, PaginationState>;
  totalUrlsCollected: number;
  createdAt: Date;
  committedToDb: boolean;
}

export interface ProxyBlocklistEntry {
  proxy: string;
  failedAt: Date;
  failureCount: number;
  lastError: string;
}