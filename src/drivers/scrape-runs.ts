import { logger } from '../utils/logger.js';
import {
  listScrapeRuns,
  getScrapeRun,
  createScrapeRun,
  updateScrapeRun,
  getScrapeRunItems,
  updateScrapeRunItem,
  getSites as getSitesProvider,
  finalizeScrapeRun as finalizeScrapeRunProvider,
  getLatestRunForDomain as getLatestRunForDomainProvider,
  fetchScrapeRun,
  type ListScrapeRunsOptions,
  type ScrapeRun,
  type ScrapeRunItem,
  type CreateScrapeRunOptions,
  type UpdateScrapeRunOptions,
  type UpdateScrapeRunItemOptions
} from '../providers/etl-api.js';

const log = logger.createContext('scrape-runs-driver');

/**
 * Driver for scrape run operations
 * Wraps ETL API provider functions with additional logic and error handling
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
    return await getScrapeRun(id);
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

export async function updateRun(id: string, options: UpdateScrapeRunOptions): Promise<ScrapeRun> {
  try {
    log.debug(`Updating scrape run ${id}`, options);
    return await updateScrapeRun(id, options);
  } catch (error) {
    log.error(`Failed to update scrape run ${id}`, { error });
    throw error;
  }
}

export async function getRunItems(runId: string): Promise<{ items: ScrapeRunItem[] }> {
  try {
    log.debug(`Getting items for scrape run ${runId}`);
    return await getScrapeRunItems(runId);
  } catch (error) {
    log.error(`Failed to get items for scrape run ${runId}`, { error });
    throw error;
  }
}

export async function updateRunItem(runId: string, url: string, options: UpdateScrapeRunItemOptions): Promise<ScrapeRunItem> {
  try {
    log.debug(`Updating item ${url} in run ${runId}`, options);
    return await updateScrapeRunItem(runId, url, options);
  } catch (error) {
    log.error(`Failed to update item ${url} in run ${runId}`, { error });
    throw error;
  }
}

export async function getSites(): Promise<any[]> {
  try {
    log.debug('Getting sites');
    return await getSitesProvider();
  } catch (error) {
    log.error('Failed to get sites', { error });
    throw error;
  }
}

export async function finalizeRun(runId: string): Promise<ScrapeRun> {
  try {
    log.debug(`Finalizing scrape run ${runId}`);
    return await finalizeScrapeRunProvider(runId);
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

// Re-export types
export type {
  ScrapeRun,
  ScrapeRunItem,
  ListScrapeRunsOptions,
  CreateScrapeRunOptions,
  UpdateScrapeRunOptions,
  UpdateScrapeRunItemOptions
};