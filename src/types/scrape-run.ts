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

export interface ListScrapeRunsQuery {
  domain?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface ListScrapeRunsResponse {
  runs: ScrapeRun[];
  total: number;
}