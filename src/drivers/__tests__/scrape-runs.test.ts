import { describe, test, expect, vi, beforeEach } from 'vitest';
import { listRuns } from '../scrape-runs.js';
import * as etlApi from '../../providers/etl-api.js';

// Mock the ETL API provider
vi.mock('../../providers/etl-api.js', () => ({
  listScrapeRuns: vi.fn()
}));

describe('scrape-runs driver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listRuns', () => {
    test('should translate since parameter to startTimeAfter', async () => {
      const mockResponse = { runs: [], total: 0 };
      vi.mocked(etlApi.listScrapeRuns).mockResolvedValue(mockResponse);

      const since = new Date('2024-01-01T00:00:00Z');
      await listRuns({ since });

      expect(etlApi.listScrapeRuns).toHaveBeenCalledWith({
        startTimeAfter: since,
        domain: undefined,
        status: undefined,
        limit: undefined,
        offset: undefined,
        until: undefined,
        page: undefined,
        sortBy: undefined,
        sortOrder: undefined
      });
    });

    test('should pass through all other parameters unchanged', async () => {
      const mockResponse = { runs: [], total: 0 };
      vi.mocked(etlApi.listScrapeRuns).mockResolvedValue(mockResponse);

      const options = {
        domain: 'example.com',
        status: 'pending',
        limit: 10,
        offset: 20,
        until: new Date('2024-12-31T23:59:59Z'),
        page: 2,
        sortBy: 'startTime' as const,
        sortOrder: 'desc' as const
      };

      await listRuns(options);

      expect(etlApi.listScrapeRuns).toHaveBeenCalledWith({
        domain: 'example.com',
        status: 'pending',
        limit: 10,
        offset: 20,
        until: options.until,
        page: 2,
        sortBy: 'startTime',
        sortOrder: 'desc',
        startTimeAfter: undefined
      });
    });

    test('should handle both since and other parameters', async () => {
      const mockResponse = { runs: [], total: 0 };
      vi.mocked(etlApi.listScrapeRuns).mockResolvedValue(mockResponse);

      const options = {
        domain: 'example.com',
        since: new Date('2024-01-01T00:00:00Z'),
        status: 'processing',
        limit: 5
      };

      await listRuns(options);

      expect(etlApi.listScrapeRuns).toHaveBeenCalledWith({
        domain: 'example.com',
        status: 'processing',
        limit: 5,
        startTimeAfter: options.since,
        offset: undefined,
        until: undefined,
        page: undefined,
        sortBy: undefined,
        sortOrder: undefined
      });
    });

    test('should handle empty options', async () => {
      const mockResponse = { runs: [], total: 0 };
      vi.mocked(etlApi.listScrapeRuns).mockResolvedValue(mockResponse);

      await listRuns();

      expect(etlApi.listScrapeRuns).toHaveBeenCalledWith({
        domain: undefined,
        status: undefined,
        limit: undefined,
        offset: undefined,
        until: undefined,
        page: undefined,
        sortBy: undefined,
        sortOrder: undefined
      });
    });

    test('should propagate errors from provider', async () => {
      const error = new Error('API error');
      vi.mocked(etlApi.listScrapeRuns).mockRejectedValue(error);

      await expect(listRuns({ domain: 'example.com' })).rejects.toThrow('API error');
    });
  });
});