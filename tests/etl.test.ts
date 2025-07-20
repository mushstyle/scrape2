import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ETLDriver } from '../src/drivers/etl.js';
import * as etlApi from '../src/providers/etl-api.js';
import * as dbUtils from '../src/db/db-utils.js';
import type { Item } from '../src/types/item.js';

// Mock the ETL API provider
vi.mock('../src/providers/etl-api.js', () => ({
  addPendingItem: vi.fn(),
  getPendingItem: vi.fn()
}));

// Mock the db utils
vi.mock('../src/db/db-utils.js', () => ({
  mkItemId: vi.fn((item: Item) => {
    // Simple mock that generates ID from sourceUrl
    return `mock-id-${item.sourceUrl?.replace(/[^a-z0-9]/gi, '-')}`;
  })
}));

describe('ETLDriver', () => {
  let driver: ETLDriver;
  const mockAddPendingItem = vi.mocked(etlApi.addPendingItem);
  const mockGetPendingItem = vi.mocked(etlApi.getPendingItem);
  const mockMkItemId = vi.mocked(dbUtils.mkItemId);

  const validItem: Item = {
    sourceUrl: 'https://example.com/product/123',
    product_id: '123',
    title: 'Test Product',
    price: 99.99,
    images: [],
    status: 'ACTIVE'
  };

  beforeEach(() => {
    vi.clearAllMocks();
    driver = new ETLDriver();
  });

  describe('addItem', () => {
    it('should add a valid item successfully', async () => {
      mockAddPendingItem.mockResolvedValueOnce(undefined);

      const result = await driver.addItem(validItem);

      expect(result.success).toBe(true);
      expect(result.itemId).toBe('mock-id-https---example-com-product-123');
      expect(result.error).toBeUndefined();
      expect(mockAddPendingItem).toHaveBeenCalledWith(validItem, result.itemId);
    });

    it('should validate required fields', async () => {
      const invalidItems = [
        { ...validItem, sourceUrl: undefined },
        { ...validItem, product_id: undefined },
        { ...validItem, title: undefined }
      ];

      for (const item of invalidItems) {
        const result = await driver.addItem(item as Item);
        expect(result.success).toBe(false);
        expect(result.error).toContain('missing required');
        expect(mockAddPendingItem).not.toHaveBeenCalled();
        vi.clearAllMocks();
      }
    });

    it('should retry on failure', async () => {
      mockAddPendingItem
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(undefined);

      const driverWithRetry = new ETLDriver({ 
        retryAttempts: 2, 
        retryDelay: 10 
      });

      const result = await driverWithRetry.addItem(validItem);

      expect(result.success).toBe(true);
      expect(mockAddPendingItem).toHaveBeenCalledTimes(2);
    });

    it('should fail after max retry attempts', async () => {
      mockAddPendingItem.mockRejectedValue(new Error('Persistent error'));

      const driverWithRetry = new ETLDriver({ 
        retryAttempts: 3, 
        retryDelay: 10 
      });

      const result = await driverWithRetry.addItem(validItem);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to add item after 3 attempts');
      expect(mockAddPendingItem).toHaveBeenCalledTimes(3);
    });
  });

  describe('addItemsBatch', () => {
    it('should process items in batches', async () => {
      mockAddPendingItem.mockResolvedValue(undefined);

      const items = Array.from({ length: 25 }, (_, i) => ({
        ...validItem,
        sourceUrl: `https://example.com/product/${i}`,
        product_id: `${i}`
      }));

      const driverWithBatch = new ETLDriver({ batchSize: 10 });
      const result = await driverWithBatch.addItemsBatch(items);

      expect(result.totalProcessed).toBe(25);
      expect(result.successful.length).toBe(25);
      expect(result.failed.length).toBe(0);
      expect(mockAddPendingItem).toHaveBeenCalledTimes(25);
    });

    it('should handle mixed success and failure', async () => {
      // Mock based on which item is being processed
      mockAddPendingItem.mockImplementation(async (item, itemId) => {
        // Fail the second item (product/1)
        if (item.sourceUrl.includes('product/1')) {
          throw new Error('Failed');
        }
        return undefined;
      });

      const items = Array.from({ length: 3 }, (_, i) => ({
        ...validItem,
        sourceUrl: `https://example.com/product/${i}`,
        product_id: `${i}`
      }));

      const driverWithRetry = new ETLDriver({ 
        retryAttempts: 2, 
        retryDelay: 10 
      });
      const result = await driverWithRetry.addItemsBatch(items);

      expect(result.totalProcessed).toBe(3);
      expect(result.successful.length).toBe(2);
      expect(result.failed.length).toBe(1);
      
      // Verify the failed item is the one we expected
      expect(result.failed[0].error).toContain('Failed');
    });
  });

  describe('getItem', () => {
    it('should retrieve an existing item', async () => {
      mockGetPendingItem.mockResolvedValueOnce(validItem);

      const result = await driver.getItem('test-id');

      expect(result).toEqual(validItem);
      expect(mockGetPendingItem).toHaveBeenCalledWith('test-id');
    });

    it('should return null for non-existent item', async () => {
      mockGetPendingItem.mockResolvedValueOnce(null);

      const result = await driver.getItem('non-existent');

      expect(result).toBeNull();
    });

    it('should throw on API error', async () => {
      mockGetPendingItem.mockRejectedValueOnce(new Error('API error'));

      await expect(driver.getItem('test-id')).rejects.toThrow('API error');
    });
  });

  describe('getItemByUrl', () => {
    it('should retrieve item by URL', async () => {
      mockGetPendingItem.mockResolvedValueOnce(validItem);

      const result = await driver.getItemByUrl('https://example.com/product/123');

      expect(result).toEqual(validItem);
      expect(mockMkItemId).toHaveBeenCalledWith({ sourceUrl: 'https://example.com/product/123' });
      expect(mockGetPendingItem).toHaveBeenCalledWith('mock-id-https---example-com-product-123');
    });
  });

  describe('itemExists', () => {
    it('should return true for existing item', async () => {
      mockGetPendingItem.mockResolvedValueOnce(validItem);

      const exists = await driver.itemExists('test-id');

      expect(exists).toBe(true);
    });

    it('should return false for non-existent item', async () => {
      mockGetPendingItem.mockResolvedValueOnce(null);

      const exists = await driver.itemExists('non-existent');

      expect(exists).toBe(false);
    });

    it('should return false for 404 errors', async () => {
      mockGetPendingItem.mockRejectedValueOnce(new Error('404 Not Found'));

      const exists = await driver.itemExists('test-id');

      expect(exists).toBe(false);
    });

    it('should throw for non-404 errors', async () => {
      mockGetPendingItem.mockRejectedValueOnce(new Error('Server error'));

      await expect(driver.itemExists('test-id')).rejects.toThrow('Server error');
    });
  });

  describe('itemExistsByUrl', () => {
    it('should check existence by URL', async () => {
      mockGetPendingItem.mockResolvedValueOnce(validItem);

      const exists = await driver.itemExistsByUrl('https://example.com/product/123');

      expect(exists).toBe(true);
      expect(mockMkItemId).toHaveBeenCalledWith({ sourceUrl: 'https://example.com/product/123' });
    });
  });
});