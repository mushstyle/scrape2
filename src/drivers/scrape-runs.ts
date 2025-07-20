import { logger } from '../utils/logger.js';
import {
  listScrapeRuns,
  createScrapeRun,
  updateScrapeRunItem,
  getSites as getSitesProvider,
  finalizeScrapeRun as finalizeScrapeRunProvider,
  getLatestRunForDomain as getLatestRunForDomainProvider,
  fetchScrapeRun
} from '../providers/etl-api.js';
import type {
  ListScrapeRunsQuery as ListScrapeRunsOptions,
  ScrapeRun,
  ScrapeRunItem,
  CreateScrapeRunRequest as CreateScrapeRunOptions,
  UpdateScrapeRunItemRequest
} from '../types/scrape-run.js';

const log = logger.createContext('scrape-runs-driver');

/**
 * Driver for scrape run operations
 * Wraps ETL API provider functions with additional logic and error handling
 */

/**
 * List scrape runs with optional filters
 * 
 * @param options.since - Filter runs created after this date (driver abstracts to API's startTimeAfter)
 * @param options.domain - Filter by domain
 * @param options.status - Filter by status
 * @param options.limit - Max results to return
 */
export async function listRuns(options: ListScrapeRunsOptions = {}): Promise<{ runs: ScrapeRun[] }> {
  try {
    log.debug('Listing scrape runs', options);
    return await listScrapeRuns(options);
  } catch (error) {
    log.error('Failed to list scrape runs', { error });
    throw error;
  }
}

export async function getRun(id: string): Promise<ScrapeRun> {
  try {
    log.debug(`Getting scrape run ${id}`);
    return await fetchScrapeRun(id);
  } catch (error) {
    log.error(`Failed to get scrape run ${id}`, { error });
    throw error;
  }
}

export async function createRun(options: CreateScrapeRunOptions): Promise<ScrapeRun> {
  try {
    log.debug('Creating scrape run', options);
    return await createScrapeRun(options);
  } catch (error) {
    log.error('Failed to create scrape run', { error });
    throw error;
  }
}

// Note: updateScrapeRun doesn't exist in the ETL API provider
// Only updateScrapeRunItem is available

export async function getRunItems(runId: string): Promise<{ items: ScrapeRunItem[] }> {
  try {
    log.debug(`Getting items for scrape run ${runId}`);
    const run = await fetchScrapeRun(runId);
    return { items: run.items };
  } catch (error) {
    log.error(`Failed to get items for scrape run ${runId}`, { error });
    throw error;
  }
}

export async function updateRunItem(runId: string, url: string, options: { done?: boolean; failed?: boolean; invalid?: boolean }): Promise<void> {
  try {
    log.debug(`Updating item ${url} in run ${runId}`, options);
    await updateScrapeRunItem(runId, { updateItem: { url, changes: options } });
  } catch (error) {
    log.error(`Failed to update item ${url} in run ${runId}`, { error });
    throw error;
  }
}

export async function getSites(): Promise<any> {
  try {
    log.debug('Getting sites');
    return await getSitesProvider();
  } catch (error) {
    log.error('Failed to get sites', { error });
    throw error;
  }
}

export async function finalizeRun(runId: string): Promise<void> {
  try {
    log.debug(`Finalizing scrape run ${runId}`);
    await finalizeScrapeRunProvider(runId);
  } catch (error) {
    log.error(`Failed to finalize scrape run ${runId}`, { error });
    throw error;
  }
}

export async function getLatestRunForDomain(domain: string): Promise<ScrapeRun | null> {
  try {
    log.debug(`Getting latest run for domain ${domain}`);
    return await getLatestRunForDomainProvider(domain);
  } catch (error) {
    log.error(`Failed to get latest run for domain ${domain}`, { error });
    throw error;
  }
}

export async function fetchRun(runId: string): Promise<ScrapeRun> {
  try {
    log.debug(`Fetching scrape run ${runId}`);
    return await fetchScrapeRun(runId);
  } catch (error) {
    log.error(`Failed to fetch scrape run ${runId}`, { error });
    throw error;
  }
}

/**
 * Get all active runs (pending or processing)
 */
export async function getActiveRuns(): Promise<ScrapeRun[]> {
  try {
    log.debug('Getting all active runs');
    
    // Get both pending and processing runs
    const [pendingResult, processingResult] = await Promise.all([
      listScrapeRuns({ status: 'pending' }),
      listScrapeRuns({ status: 'processing' })
    ]);
    
    const allRuns = [...pendingResult.runs, ...processingResult.runs];
    log.debug(`Found ${allRuns.length} active runs`);
    
    return allRuns;
  } catch (error) {
    log.error('Failed to get active runs', { error });
    throw error;
  }
}

// Re-export types
export type {
  ScrapeRun,
  ScrapeRunItem,
  ListScrapeRunsOptions,
  CreateScrapeRunOptions,
  UpdateScrapeRunItemRequest
};