/**
 * ETL API Provider
 * 
 * This module provides functions to interact with our ETL API.
 * It handles site configuration, metadata, and will be extended
 * with additional ETL API functionality in the future.
 */

import { SiteScrapingConfigData, ApiSitesResponse, ApiSiteMetadata } from '../types/siteScrapingConfig.js';

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
  const baseUrl = getApiBaseUrl();
  const token = getApiBearerToken();

  const url = `${baseUrl}/api/sites/${siteId}/scraping-config`;

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
  const baseUrl = getApiBaseUrl();
  const token = getApiBearerToken();

  const url = `${baseUrl}/api/sites/${siteId}/scraping-config`;

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
  const baseUrl = getApiBaseUrl();
  const token = getApiBearerToken();

  const url = `${baseUrl}/api/sites`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });
  return handleApiResponse(response);
};

export const getSiteById = async (siteId: string): Promise<ApiSiteMetadata> => {
  const baseUrl = getApiBaseUrl();
  const token = getApiBearerToken();

  const url = `${baseUrl}/api/sites/${siteId}`;

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