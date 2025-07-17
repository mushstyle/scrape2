/**
 * VerifyPaginateEngine
 * 
 * Core engine for verifying pagination functionality of a scraper.
 * Runs through all startPages of a site respecting sessionLimit.
 * Designed to be callable from CLI scripts or API endpoints.
 */

import { SessionManager } from '../services/session-manager.js';
import { SiteManager } from '../services/site-manager.js';
import { createBrowserFromSession } from '../drivers/browser.js';
import { logger } from '../utils/logger.js';
import { loadScraper } from '../drivers/scraper-loader.js';
import type { Session } from '../types/session.js';
import type { Page } from 'playwright';

const log = logger.createContext('verify-paginate-engine');

interface PaginateWorker {
  startUrl: string;
  session: Session;
  page: Page;
  scraper: any;
  urls: Set<string>;
  pageCount: number;
  done: boolean;
  error?: string;
}

export interface VerifyPaginateOptions {
  domain: string;
  maxIterations?: number;
  sessionManager?: SessionManager;
  siteManager?: SiteManager;
}

export interface VerifyPaginateResult {
  success: boolean;
  domain: string;
  startPagesCount: number;
  totalPagesScraped: number;
  totalUniqueUrls: number;
  failedWorkers: number;
  sampleUrls: string[];
  errors: string[];
  duration: number;
}

export class VerifyPaginateEngine {
  private sessionManager: SessionManager;
  private siteManager: SiteManager;
  
  constructor(options: Partial<VerifyPaginateOptions> = {}) {
    this.sessionManager = options.sessionManager || new SessionManager();
    this.siteManager = options.siteManager || new SiteManager();
  }
  
  async verify(options: VerifyPaginateOptions): Promise<VerifyPaginateResult> {
    const startTime = Date.now();
    const workers: PaginateWorker[] = [];
    const errors: string[] = [];
    
    try {
      // Initialize
      await this.siteManager.loadSites();
      const siteConfig = this.siteManager.getSiteConfig(options.domain);
      if (!siteConfig) {
        throw new Error(`No site config for ${options.domain}`);
      }
      
      if (!siteConfig.startPages?.length) {
        throw new Error(`No start pages configured for ${options.domain}`);
      }
      
      // Load scraper
      const scraper = await loadScraper(options.domain);
      log.normal(`Loaded scraper for ${options.domain}`);
      
      // Determine session limit from site manager (which uses proxy strategy)
      const sessionLimit = await this.siteManager.getSessionLimitForDomain(options.domain);
      const sessionsToCreate = Math.min(sessionLimit, siteConfig.startPages.length);
      
      log.normal(`Site: ${options.domain}`);
      log.normal(`Start pages: ${siteConfig.startPages.length}`);
      log.normal(`Session limit: ${sessionLimit}`);
      log.normal(`Creating ${sessionsToCreate} sessions`);
      
      // Create workers for parallel execution
      for (let i = 0; i < sessionsToCreate; i++) {
        // Add delay between session creation to avoid rate limits
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        // Get proxy for domain from SiteManager
        const proxy = await this.siteManager.getProxyForDomain(options.domain);
        
        const session = await this.sessionManager.createSession({ 
          domain: options.domain,
          proxy 
        });
        const { browser, createContext } = await createBrowserFromSession(session);
        const context = await createContext();
        
        // Distribute start pages across workers
        for (let j = i; j < siteConfig.startPages.length; j += sessionsToCreate) {
          const page = await context.newPage();
          workers.push({
            startUrl: siteConfig.startPages[j],
            session,
            page,
            scraper,
            urls: new Set(),
            pageCount: 0,
            done: false
          });
        }
      }
      
      log.normal(`\nStarting pagination verification with ${workers.length} workers...`);
      
      // Navigate to start pages
      await Promise.all(workers.map(async (worker) => {
        try {
          log.normal(`Navigating to ${worker.startUrl}`);
          await worker.page.goto(worker.startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          worker.pageCount = 1;
        } catch (error) {
          worker.error = `Failed to navigate: ${error.message}`;
          worker.done = true;
          errors.push(`${worker.startUrl}: ${worker.error}`);
        }
      }));
      
      // Paginate until all workers are done or we hit a limit
      let iteration = 0;
      const maxIterations = options.maxIterations || 10;
      
      while (workers.some(w => !w.done) && iteration < maxIterations) {
        iteration++;
        log.normal(`\n--- Pagination iteration ${iteration} ---`);
        
        // Run pagination for all active workers in parallel
        const activeWorkers = workers.filter(w => !w.done);
        await Promise.all(activeWorkers.map(worker => this.paginateWorker(worker)));
        
        // Brief pause between iterations
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // Compile results
      const allUrls = new Set<string>();
      let totalPages = 0;
      let failedWorkers = 0;
      
      workers.forEach((worker) => {
        worker.urls.forEach(url => allUrls.add(url));
        totalPages += worker.pageCount;
        if (worker.error) {
          failedWorkers++;
          errors.push(`${worker.startUrl}: ${worker.error}`);
        }
      });
      
      const result: VerifyPaginateResult = {
        success: failedWorkers === 0,
        domain: options.domain,
        startPagesCount: siteConfig.startPages.length,
        totalPagesScraped: totalPages,
        totalUniqueUrls: allUrls.size,
        failedWorkers,
        sampleUrls: Array.from(allUrls).slice(0, 10),
        errors,
        duration: Date.now() - startTime
      };
      
      // Cleanup
      log.normal('Cleaning up...');
      await this.cleanup(workers);
      
      return result;
      
    } catch (error) {
      log.error(`Fatal error: ${error.message}`);
      errors.push(`Fatal: ${error.message}`);
      
      // Cleanup on error
      await this.cleanup(workers);
      
      return {
        success: false,
        domain: options.domain,
        startPagesCount: 0,
        totalPagesScraped: 0,
        totalUniqueUrls: 0,
        failedWorkers: workers.length,
        sampleUrls: [],
        errors,
        duration: Date.now() - startTime
      };
    }
  }
  
  private async paginateWorker(worker: PaginateWorker): Promise<void> {
    try {
      // Get URLs from current page
      const urls = await worker.scraper.getItemUrls(worker.page);
      log.normal(`Page ${worker.pageCount}: Found ${urls.size} URLs (${worker.startUrl})`);
      urls.forEach(url => worker.urls.add(url));
      
      // Try to go to next page
      const hasMore = await worker.scraper.paginate(worker.page);
      if (!hasMore) {
        log.normal(`No more pages for ${worker.startUrl} (total: ${worker.pageCount} pages, ${worker.urls.size} URLs)`);
        worker.done = true;
        return;
      }
      
      worker.pageCount++;
    } catch (error) {
      log.error(`Error during pagination: ${error.message} (${worker.startUrl})`);
      worker.error = error.message;
      worker.done = true;
    }
  }
  
  private async cleanup(workers: PaginateWorker[]): Promise<void> {
    const cleanupPromises: Promise<void>[] = [];
    
    // Close all pages and contexts
    const contexts = new Set<any>();
    for (const worker of workers) {
      if (worker.page) {
        const context = worker.page.context();
        contexts.add(context);
        cleanupPromises.push(
          worker.page.close().catch(e => log.debug(`Failed to close page: ${e.message}`))
        );
      }
    }
    
    // Close contexts
    for (const context of contexts) {
      cleanupPromises.push(
        context.close().catch(e => log.debug(`Failed to close context: ${e.message}`))
      );
    }
    
    // Wait for all cleanup
    await Promise.all(cleanupPromises);
    
    // Destroy all sessions
    await this.sessionManager.destroyAllSessions();
  }
}