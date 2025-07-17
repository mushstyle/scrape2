/**
 * Represents a target URL for scraping (either pagination or item scraping)
 */
export interface ScrapeTarget {
  url: string;
  done: boolean | null;
  failed: boolean | null;
  invalid: boolean | null;
  failReason?: string;  // Optional reason for failure
  failedReason?: string | null;  // API returns this field name
  created_at?: string;
  updated_at?: string;
}

/**
 * Legacy alias for compatibility during migration
 * @deprecated Use ScrapeTarget instead
 */
export type ScrapeRunItem = ScrapeTarget;