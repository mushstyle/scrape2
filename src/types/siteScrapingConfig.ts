// src/types/siteScrapingConfig.ts

export interface BrowserConfig {
  headless?: boolean | null;
  userAgent?: string | null;
  ignoreHttpsErrors?: boolean | null;
  headers?: Record<string, string> | null;
  args?: string[] | null;
  viewport?: { width: number; height: number; } | null;
}

export interface ScrapeConfig {
  browser?: BrowserConfig | null;
  scraperFile?: string | null;
  startPages?: string[] | null;
}

// This type represents the data structure for GET/PATCH of scraping-config specific endpoint
export interface SiteScrapingConfigData {
  scrapeConfig?: ScrapeConfig | null;
}

// --- New types for full site metadata from GET /api/sites --- 

// Represents a single site object as returned by GET /api/sites
export interface ApiSiteMetadata {
  _id: string; // Domain name
  name?: string; // Often the same as _id or a display name
  title?: string; // Optional display title (if different from name)
  scraperFile?: string | null; // Could be top-level or within scrapeConfig
  startPages?: string[] | null; // Could be top-level or within scrapeConfig, should be string[]
  browserConfig?: BrowserConfig | null; // Could be top-level or within scrapeConfig.browser

  // The API returns scrapeConfig as a nested object
  // We will map to this structure, but our internal getSiteConfig might flatten it
  scrapeConfig?: ScrapeConfig | null;

  // Add other fields from the API response as needed, e.g.:
  status?: string;
  settings?: Record<string, any>;
  filters?: string[];
  metrics?: Record<string, any>;
  createdAt?: string;
  updatedAt?: string;
  isReworkd?: boolean;
  priority?: { $numberInt: string } | number | null;
  // ... any other relevant fields from the curl output
}

// Represents the overall structure of the GET /api/sites response
export interface ApiSitesResponse {
  sites: ApiSiteMetadata[];
} 