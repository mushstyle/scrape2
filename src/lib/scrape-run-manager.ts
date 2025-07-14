import { logger } from './logger.js';
import {
  createScrapeRun,
  fetchScrapeRun,
  listScrapeRuns,
  updateScrapeRunItem,
  finalizeScrapeRun,
  getLatestRunForDomain
} from '../providers/etl-api.js';
import type {
  ScrapeRun,
  ScrapeRunItem,
  CreateScrapeRunRequest
} from '../types/scrape-run.js';
import type { ItemStats } from '../types/orchestration.js';

const log = logger.createContext('scrape-run-manager');

export class ScrapeRunManager {
  /**
   * Create a new scrape run
   */
  async createRun(domain: string, urls?: string[]): Promise<ScrapeRun> {
    const request: CreateScrapeRunRequest = { domain };
    if (urls && urls.length > 0) {
      request.urls = urls;
    }
    
    try {
      const run = await createScrapeRun(request);
      log.normal(`Created run ${run.id} for domain ${domain} with ${run.items.length} items`);
      return run;
    } catch (error) {
      log.error(`Failed to create run for domain ${domain}`, { error });
      throw error;
    }
  }
  
  /**
   * Get active run for a domain (most recent non-completed run)
   */
  async getActiveRun(domain: string): Promise<ScrapeRun | null> {
    try {
      const response = await listScrapeRuns({
        domain,
        status: 'processing',
        limit: 1
      });
      
      if (response.runs.length > 0) {
        return response.runs[0];
      }
      
      // Check for pending runs if no processing runs
      const pendingResponse = await listScrapeRuns({
        domain,
        status: 'pending',
        limit: 1
      });
      
      return pendingResponse.runs.length > 0 ? pendingResponse.runs[0] : null;
    } catch (error) {
      log.error(`Failed to get active run for domain ${domain}`, { error });
      return null;
    }
  }
  
  /**
   * Get pending items from a run (not done)
   */
  async getPendingItems(runId: string): Promise<ScrapeRunItem[]> {
    try {
      const run = await fetchScrapeRun(runId);
      const pendingItems = run.items.filter(item => !item.done);
      log.debug(`Found ${pendingItems.length} pending items in run ${runId}`);
      return pendingItems;
    } catch (error) {
      log.error(`Failed to get pending items for run ${runId}`, { error });
      return [];
    }
  }
  
  /**
   * Update item status
   */
  async updateItemStatus(
    runId: string,
    url: string,
    status: { done?: boolean; failed?: boolean; invalid?: boolean }
  ): Promise<void> {
    try {
      await updateScrapeRunItem(runId, {
        updateItem: {
          url,
          changes: status
        }
      });
      log.debug(`Updated item ${url} in run ${runId}`, status);
    } catch (error) {
      log.error(`Failed to update item ${url} in run ${runId}`, { error });
      throw error;
    }
  }
  
  /**
   * Batch update item statuses
   */
  async updateItemStatuses(
    runId: string,
    updates: Array<{ url: string; status: { done?: boolean; failed?: boolean; invalid?: boolean } }>
  ): Promise<void> {
    // Process updates in parallel with concurrency limit
    const batchSize = 10;
    for (let i = 0; i < updates.length; i += batchSize) {
      const batch = updates.slice(i, i + batchSize);
      await Promise.all(
        batch.map(({ url, status }) => this.updateItemStatus(runId, url, status))
      );
    }
    log.normal(`Updated ${updates.length} items in run ${runId}`);
  }
  
  /**
   * Finalize a run
   */
  async finalizeRun(runId: string): Promise<void> {
    try {
      // Calculate metadata before finalizing
      const run = await fetchScrapeRun(runId);
      const stats = this.calculateRunStats(run);
      
      await finalizeScrapeRun(runId);
      log.normal(`Finalized run ${runId}`, stats);
    } catch (error) {
      log.error(`Failed to finalize run ${runId}`, { error });
      throw error;
    }
  }
  
  /**
   * Get run statistics
   */
  async getRunStats(runId: string): Promise<ItemStats> {
    try {
      const run = await fetchScrapeRun(runId);
      return this.calculateRunStats(run);
    } catch (error) {
      log.error(`Failed to get stats for run ${runId}`, { error });
      return {
        total: 0,
        pending: 0,
        completed: 0,
        failed: 0,
        invalid: 0
      };
    }
  }
  
  /**
   * Calculate run statistics from a ScrapeRun
   */
  private calculateRunStats(run: ScrapeRun): ItemStats {
    const stats: ItemStats = {
      total: run.items.length,
      pending: 0,
      completed: 0,
      failed: 0,
      invalid: 0
    };
    
    run.items.forEach(item => {
      if (item.done) {
        stats.completed++;
      } else if (item.failed) {
        stats.failed++;
      } else if (item.invalid) {
        stats.invalid++;
      } else {
        stats.pending++;
      }
    });
    
    return stats;
  }
  
  /**
   * Get or create a run for a domain
   */
  async getOrCreateRun(domain: string, urls?: string[]): Promise<ScrapeRun> {
    // Check for existing active run
    const activeRun = await this.getActiveRun(domain);
    if (activeRun) {
      log.normal(`Using existing run ${activeRun.id} for domain ${domain}`);
      return activeRun;
    }
    
    // Create new run
    return this.createRun(domain, urls);
  }
}