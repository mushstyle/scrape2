/**
 * ETL API Provider
 * 
 * This module provides functions to interact with our ETL API.
 * It handles site configuration, metadata, and will be extended
 * with additional ETL API functionality in the future.
 */

import type { SiteScrapingConfigData, ApiSitesResponse, ApiSiteMetadata } from '../types/siteScrapingConfig.js';
import { logger } from '../utils/logger.js';
import type {
  ScrapeRun,
  CreateScrapeRunRequest,
  UpdateScrapeRunItemRequest,
  FinalizeRunRequest,
  ListScrapeRunsQuery,
  ListScrapeRunsResponse
} from '../types/scrape-run.js';

const getApiBaseUrl = (): string => {
  const baseUrl = process.env.ETL_API_ENDPOINT;
  if (!baseUrl) {
    console.error('ETL_API_ENDPOINT environment variable is not set.');
    throw new Error('ETL_API_ENDPOINT environment variable is not set.');
  }
  // Remove quotes if present
  return baseUrl.replace(/^["']|["']$/g, '');
};

const getApiBearerToken = (): string => {
  const token = process.env.ETL_API_KEY;
  if (!token) {
    console.error('ETL_API_KEY environment variable is not set.');
    throw new Error('ETL_API_KEY environment variable is not set.');
  }
  return token;
};

const handleApiResponse = async (response: Response) => {
  if (!response.ok) {
    let errorMessage = `API Error: ${response.status} ${response.statusText}`;
    try {
      const errorBody = await response.json();
      errorMessage += ` - Details: ${JSON.stringify(errorBody)}`;
    } catch (e) {
      // If error body is not JSON or empty, use the status text.
    }
    console.error(errorMessage);
    throw new Error(errorMessage);
  }
  // Handle cases where the response might be empty (e.g., 204 No Content)
  // The current API spec implies JSON for 200 OK for both GET and PATCH.
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json();
  }
  return {}; // Or handle as appropriate if non-JSON responses are expected for success
};

export const getSiteScrapingConfig = async (siteId: string): Promise<SiteScrapingConfigData> => {
  const token = getApiBearerToken();
  const url = buildApiUrl(API_ENDPOINTS.scrapingConfig(siteId));

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      // 'Content-Type': 'application/json', // Not typically needed for GET requests
    },
  });

  return handleApiResponse(response);
};

export const updateSiteScrapingConfig = async (
  siteId: string,
  payload: SiteScrapingConfigData,
): Promise<SiteScrapingConfigData> => {
  const token = getApiBearerToken();
  const url = buildApiUrl(API_ENDPOINTS.scrapingConfig(siteId));

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return handleApiResponse(response);
};

export const getSites = async (): Promise<ApiSitesResponse> => {
  const token = getApiBearerToken();
  const url = buildApiUrl(API_ENDPOINTS.sites);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });
  return handleApiResponse(response);
};

export const getSiteById = async (siteId: string): Promise<ApiSiteMetadata> => {
  const token = getApiBearerToken();
  const url = buildApiUrl(API_ENDPOINTS.site(siteId));

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });
  // Assuming the response for a single site is directly the ApiSiteMetadata object
  // If it's nested like { site: ApiSiteMetadata }, this will need adjustment
  return handleApiResponse(response);
};

const log = logger.createContext('etl-api');

/**
 * Helper to build API URLs consistently
 */
function buildApiUrl(path: string): string {
  const base = getApiBaseUrl();
  return `${base}${path}`;
}

/**
 * Central API endpoint definitions
 */
const API_ENDPOINTS = {
  scrapeRuns: '/api/scrape-runs',
  scrapeRun: (runId: string) => `/api/scrape-runs/${runId}`,
  sites: '/api/sites',
  site: (siteId: string) => `/api/sites/${siteId}`,
  scrapingConfig: (siteId: string) => `/api/sites/${siteId}/scraping-config`
} as const;

/**
 * Helper to normalize response field names (handles _id/id, created_at/createdAt variations)
 */
function normalizeRunResponse(run: any): ScrapeRun {
  return {
    id: run.id || run._id,
    _id: run._id,
    domain: run.domain,
    items: (run.items || []).map((item: any) => ({
      url: item.url,
      done: item.done === true,  // Convert null to false
      failed: item.failed === true,  // Convert null to false
      invalid: item.invalid === true,  // Convert null to false
      failReason: item.failReason || item.failedReason,
      created_at: item.created_at,
      updated_at: item.updated_at
    })),
    status: run.status || 'pending',
    created_at: run.created_at || run.createdAt,
    createdAt: run.createdAt,
    updated_at: run.updated_at || run.updatedAt,
    updatedAt: run.updatedAt,
    metadata: run.metadata
  };
}

/**
 * Create a new scrape run
 */
export async function createScrapeRun(request: CreateScrapeRunRequest): Promise<ScrapeRun> {
  const url = buildApiUrl(API_ENDPOINTS.scrapeRuns);
  const token = getApiBearerToken();
  
  // Convert urls to items if needed
  const apiRequest = { ...request };
  if (request.urls && request.urls.length > 0 && !request.items) {
    apiRequest.items = request.urls.map(url => ({ url }));
    delete apiRequest.urls;
  }
  
  const body = JSON.stringify(apiRequest);
  log.debug(`Creating scrape run with request: ${body}`);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body
    });

    if (!response.ok) {
      throw new Error(`Failed to create scrape run: ${response.statusText}`);
    }

    const data = await response.json();
    log.debug(`API returned scrape run: ${JSON.stringify(data)}`);
    log.normal(`Created scrape run ${data.id || data._id} for domain ${request.domain}`);
    
    return normalizeRunResponse(data);
  } catch (error) {
    log.error('Error creating scrape run', { error });
    throw error;
  }
}

/**
 * Fetch a specific scrape run by ID
 */
export async function fetchScrapeRun(runId: string): Promise<ScrapeRun> {
  const url = buildApiUrl(API_ENDPOINTS.scrapeRun(runId));
  const token = getApiBearerToken();
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch scrape run: ${response.statusText}`);
    }

    const data = await response.json();
    return normalizeRunResponse(data);
  } catch (error) {
    log.error(`Error fetching scrape run ${runId}`, { error });
    throw error;
  }
}

/**
 * List scrape runs with optional filters
 * 
 * @param query - Query parameters for filtering scrape runs
 * @param query.domain - Filter by specific domain
 * @param query.status - Filter by status (pending, processing, completed, failed)
 * @param query.since - Filter runs after this date (maps to API's startTimeAfter parameter)
 * @param query.until - Filter runs before this date
 * @param query.limit - Number of results per page (default: 50)
 * @param query.offset - Offset for pagination
 * @param query.page - Page number for pagination (alternative to offset)
 * @param query.sortBy - Field to sort by (startTime, createdAt, domain, endTime)
 * @param query.sortOrder - Sort direction (asc, desc) - default: desc
 */
export async function listScrapeRuns(query?: ListScrapeRunsQuery): Promise<ListScrapeRunsResponse> {
  const params = new URLSearchParams();
  if (query?.domain) params.append('domain', query.domain);
  if (query?.status) params.append('status', query.status);
  // API expects 'startTimeAfter' not 'since'
  if (query?.since) params.append('startTimeAfter', query.since.toISOString());
  if (query?.until) params.append('until', query.until.toISOString());
  if (query?.limit) params.append('limit', query.limit.toString());
  if (query?.offset) params.append('offset', query.offset.toString());
  // Additional optional parameters
  if (query?.page) params.append('page', query.page.toString());
  if (query?.sortBy) params.append('sortBy', query.sortBy);
  if (query?.sortOrder) params.append('sortOrder', query.sortOrder);
  
  const url = buildApiUrl(`${API_ENDPOINTS.scrapeRuns}?${params.toString()}`);
  const token = getApiBearerToken();
  
  log.debug(`Fetching scrape runs from: ${url}`);
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to list scrape runs: ${response.statusText}`);
    }

    const data = await response.json();
    log.debug('API response:', { data });
    
    // The API returns { data: [...] } format
    const runs = data.data || data.runs || (Array.isArray(data) ? data : []);
    return {
      runs: runs.map(normalizeRunResponse),
      total: data.total || runs.length
    };
  } catch (error) {
    log.error('Error listing scrape runs', { error });
    throw error;
  }
}

/**
 * Update a scrape run item's status
 */
export async function updateScrapeRunItem(runId: string, request: UpdateScrapeRunItemRequest): Promise<void> {
  const url = buildApiUrl(API_ENDPOINTS.scrapeRun(runId));
  const token = getApiBearerToken();
  
  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`Failed to update scrape run item: ${response.statusText}`);
    }

    log.debug(`Updated item ${request.updateItem.url} in run ${runId}`);
  } catch (error) {
    log.error(`Error updating scrape run item in run ${runId}`, { error });
    throw error;
  }
}

/**
 * Finalize a scrape run (mark as completed)
 */
export async function finalizeScrapeRun(runId: string): Promise<void> {
  const url = buildApiUrl(API_ENDPOINTS.scrapeRun(runId));
  const token = getApiBearerToken();
  const request: FinalizeRunRequest = { finalize: true };
  
  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`Failed to finalize scrape run: ${response.statusText}`);
    }

    log.normal(`Finalized scrape run ${runId}`);
  } catch (error) {
    log.error(`Error finalizing scrape run ${runId}`, { error });
    throw error;
  }
}

/**
 * Get the latest run for a domain (convenience function)
 */
export async function getLatestRunForDomain(domain: string): Promise<ScrapeRun | null> {
  try {
    const response = await listScrapeRuns({
      domain,
      limit: 1
    });
    
    return response.runs.length > 0 ? response.runs[0] : null;
  } catch (error) {
    log.error(`Error getting latest run for domain ${domain}`, { error });
    return null;
  }
}

/**
 * Get site config with proxy strategy merged from local proxy-strategies.json
 * This is a re-export for convenience from the site-config module
 */
// Site config is now in drivers/site-config.ts 