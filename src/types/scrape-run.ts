import type { ScrapeTarget, ScrapeRunItem } from './scrape-target.js';

export { ScrapeRunItem };  // Re-export for compatibility

export interface ScrapeRun {
  id: string;
  _id?: string;
  domain: string;
  items: ScrapeRunItem[];
  status: 'pending' | 'processing' | 'completed' | 'failed';
  created_at: string;
  createdAt?: string;
  updated_at: string;
  updatedAt?: string;
  metadata?: {
    totalItems?: number;
    processedItems?: number;
    failedItems?: number;
    invalidItems?: number;
  };
}

export interface CreateScrapeRunRequest {
  domain: string;
  urls?: string[];
  items?: Array<{ url: string }>;
  source?: string;
  metadata?: {
    started_at?: string;
  };
}

export interface CreateScrapeRunResponse {
  id: string;
  _id?: string;
  domain: string;
  items: ScrapeRunItem[];
  status: string;
  created_at: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
  metadata?: {
    totalItems?: number;
    processedItems?: number;
    failedItems?: number;
    invalidItems?: number;
    started_at?: string;
    finished_at?: string;
    finished_count?: number;
    total_count?: number;
    failed_count?: number;
  };
  source?: string;
  startTime?: string;
  endTime?: string;
}

export interface UpdateScrapeRunItemRequest {
  updateItem: {
    url: string;
    changes: {
      done?: boolean;
      failed?: boolean;
      invalid?: boolean;
    };
  };
}

export interface FinalizeRunRequest {
  finalize: boolean;
}

// Driver interface - uses friendly parameter names
export interface ListScrapeRunsQuery {
  domain?: string;
  status?: string;
  limit?: number;
  offset?: number;
  since?: Date;  // Driver translates to startTimeAfter
  until?: Date;
  // Additional optional parameters supported by the API
  page?: number;
  sortBy?: 'startTime' | 'createdAt' | 'domain' | 'endTime';
  sortOrder?: 'asc' | 'desc';
}

// Provider interface - uses exact API parameter names
export interface ListScrapeRunsProviderQuery {
  domain?: string;
  status?: string;
  limit?: number;
  offset?: number;
  startTimeAfter?: Date;  // API parameter name
  until?: Date;
  // Additional optional parameters supported by the API
  page?: number;
  sortBy?: 'startTime' | 'createdAt' | 'domain' | 'endTime';
  sortOrder?: 'asc' | 'desc';
}

export interface ListScrapeRunsResponse {
  runs: ScrapeRun[];
  total: number;
  data?: ScrapeRun[];  // API sometimes returns data instead of runs
  pagination?: {
    currentPage: number;
    totalPages: number;
    totalItems: number;
    limit: number;
  };
}