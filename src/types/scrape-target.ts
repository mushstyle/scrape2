/**
 * Represents a target URL for scraping (either pagination or item scraping)
 */
export interface ScrapeTarget {
  url: string;
  done: boolean;
  failed: boolean;
  invalid: boolean;
  failReason?: string;  // Optional reason for failure
  created_at?: string;
  updated_at?: string;
}

/**
 * Legacy alias for compatibility during migration
 * @deprecated Use ScrapeTarget instead
 */
export type ScrapeRunItem = ScrapeTarget;