/**
 * ETL Driver
 * 
 * This driver provides a high-level interface for ETL operations,
 * wrapping the ETL API provider functions with additional functionality
 * like ID generation, validation, and batch operations.
 */

import { addPendingItem, getPendingItem } from '../providers/etl-api.js';
import { mkItemId } from '../db/db-utils.js';
import { logger } from '../utils/logger.js';
import type { Item } from '../types/item.js';

const log = logger.createContext('etl-driver');

export interface ETLDriverOptions {
  batchSize?: number;
  retryAttempts?: number;
  retryDelay?: number;
}

export interface AddItemResult {
  itemId: string;
  success: boolean;
  error?: string;
}

export interface BatchAddResult {
  successful: AddItemResult[];
  failed: AddItemResult[];
  totalProcessed: number;
}

/**
 * Driver for ETL operations including pending items management
 */
export class ETLDriver {
  private options: Required<ETLDriverOptions>;

  constructor(options: ETLDriverOptions = {}) {
    this.options = {
      batchSize: options.batchSize || 10,
      retryAttempts: options.retryAttempts || 2,
      retryDelay: options.retryDelay || 1000
    };
  }

  /**
   * Add a single item to pending items
   * 
   * @param item - The item data to add
   * @returns Result with generated item ID and success status
   */
  async addItem(item: Item): Promise<AddItemResult> {
    try {
      // Generate item ID
      const itemId = mkItemId(item);
      
      // Validate item has required fields
      if (!item.sourceUrl) {
        throw new Error('Item missing required sourceUrl field');
      }
      if (!item.product_id) {
        throw new Error('Item missing required product_id field');
      }
      if (!item.title) {
        throw new Error('Item missing required title field');
      }
      
      // Add item with retry logic
      let lastError: Error | undefined;
      for (let attempt = 1; attempt <= this.options.retryAttempts; attempt++) {
        try {
          await addPendingItem(item, itemId);
          log.normal(`Added item ${itemId.substring(0, 8)} from ${item.sourceUrl}`);
          return { itemId, success: true };
        } catch (error) {
          lastError = error as Error;
          log.debug(`Attempt ${attempt} failed for item ${itemId.substring(0, 8)}: ${lastError.message}`);
          
          if (attempt < this.options.retryAttempts) {
            await new Promise(resolve => setTimeout(resolve, this.options.retryDelay));
          }
        }
      }
      
      // All attempts failed
      const errorMsg = `Failed to add item after ${this.options.retryAttempts} attempts: ${lastError?.message}`;
      log.error(errorMsg);
      return { itemId, success: false, error: errorMsg };
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Error adding item: ${errorMsg}`);
      return { itemId: '', success: false, error: errorMsg };
    }
  }

  /**
   * Add multiple items in batches
   * 
   * @param items - Array of items to add
   * @returns Batch result with successful and failed items
   */
  async addItemsBatch(items: Item[]): Promise<BatchAddResult> {
    const successful: AddItemResult[] = [];
    const failed: AddItemResult[] = [];
    
    log.normal(`Processing ${items.length} items in batches of ${this.options.batchSize}`);
    
    // Process items in batches
    for (let i = 0; i < items.length; i += this.options.batchSize) {
      const batch = items.slice(i, i + this.options.batchSize);
      const batchNum = Math.floor(i / this.options.batchSize) + 1;
      const totalBatches = Math.ceil(items.length / this.options.batchSize);
      
      log.normal(`Processing batch ${batchNum}/${totalBatches} (${batch.length} items)`);
      
      // Process batch in parallel
      const results = await Promise.all(
        batch.map(item => this.addItem(item))
      );
      
      // Categorize results
      results.forEach(result => {
        if (result.success) {
          successful.push(result);
        } else {
          failed.push(result);
        }
      });
      
      // Small delay between batches to avoid overwhelming the API
      if (i + this.options.batchSize < items.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    log.normal(`Batch complete: ${successful.length} successful, ${failed.length} failed`);
    
    return {
      successful,
      failed,
      totalProcessed: items.length
    };
  }

  /**
   * Get a pending item by ID
   * 
   * @param itemId - The item ID to retrieve
   * @returns The item if found, null otherwise
   */
  async getItem(itemId: string): Promise<Item | null> {
    try {
      const item = await getPendingItem(itemId);
      if (item) {
        log.debug(`Retrieved item ${itemId.substring(0, 8)}`);
      } else {
        log.debug(`Item ${itemId.substring(0, 8)} not found`);
      }
      return item;
    } catch (error) {
      log.error(`Error retrieving item ${itemId}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Get a pending item by source URL
   * 
   * @param sourceUrl - The source URL of the item
   * @returns The item if found, null otherwise
   */
  async getItemByUrl(sourceUrl: string): Promise<Item | null> {
    try {
      // Create a dummy item with just the URL to generate the ID
      const dummyItem: Partial<Item> = { sourceUrl };
      const itemId = mkItemId(dummyItem as Item);
      
      return await this.getItem(itemId);
    } catch (error) {
      log.error(`Error retrieving item by URL ${sourceUrl}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Check if an item exists in pending items
   * 
   * @param itemId - The item ID to check
   * @returns True if the item exists, false otherwise
   */
  async itemExists(itemId: string): Promise<boolean> {
    try {
      const item = await this.getItem(itemId);
      return item !== null;
    } catch (error) {
      // If there's an error other than 404, we should still throw it
      if (error instanceof Error && error.message.includes('404')) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Check if an item exists by URL
   * 
   * @param sourceUrl - The source URL to check
   * @returns True if the item exists, false otherwise
   */
  async itemExistsByUrl(sourceUrl: string): Promise<boolean> {
    try {
      const item = await this.getItemByUrl(sourceUrl);
      return item !== null;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return false;
      }
      throw error;
    }
  }
}

/**
 * Create a singleton instance for convenience
 */
export const etlDriver = new ETLDriver();