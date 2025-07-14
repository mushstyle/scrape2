import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSiteConfig } from '../src/providers/site-config.js';
import * as etlApi from '../src/providers/etl-api.js';
import * as localDb from '../src/providers/local-db.js';

// Mock the modules
vi.mock('../src/providers/etl-api.js');
vi.mock('../src/providers/local-db.js');

describe('getSiteConfig', () => {
  const mockApiResponse = {
    _id: 'test.com',
    scrapeConfig: {
      scraperFile: 'test.ts',
      startPages: ['https://test.com/products'],
      browser: {
        ignoreHttpsErrors: true,
        userAgent: 'test-agent',
        headers: { 'X-Test': 'true' },
        headless: true,
        args: ['--no-sandbox'],
        viewport: { width: 1920, height: 1080 }
      }
    }
  };

  const mockProxyStrategies = {
    'test.com': {
      strategy: 'datacenter',
      geo: 'US',
      cooldownMinutes: 30,
      failureThreshold: 2,
      sessionLimit: 3
    },
    'default': {
      strategy: 'residential-stable',
      geo: 'UK',
      cooldownMinutes: 60,
      failureThreshold: 3,
      sessionLimit: 5
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should merge domain-specific proxy strategy into site config', async () => {
    vi.mocked(etlApi.getSiteById).mockResolvedValue(mockApiResponse);
    vi.mocked(localDb.loadProxyStrategies).mockResolvedValue(mockProxyStrategies);

    const config = await getSiteConfig('test.com');

    expect(config).toEqual({
      domain: 'test.com',
      scraper: 'test.ts',
      startPages: ['https://test.com/products'],
      scraping: {
        browser: {
          ignoreHttpsErrors: true,
          userAgent: 'test-agent',
          headers: { 'X-Test': 'true' },
          headless: true,
          args: ['--no-sandbox'],
          viewport: { width: 1920, height: 1080 }
        }
      },
      proxy: {
        strategy: 'datacenter',
        geo: 'US',
        cooldownMinutes: 30,
        failureThreshold: 2,
        sessionLimit: 3
      }
    });
  });

  it('should fall back to default proxy strategy when domain not found', async () => {
    vi.mocked(etlApi.getSiteById).mockResolvedValue({
      _id: 'unknown.com',
      scrapeConfig: {
        browser: {}
      }
    });
    vi.mocked(localDb.loadProxyStrategies).mockResolvedValue(mockProxyStrategies);

    const config = await getSiteConfig('unknown.com');

    expect(config.proxy).toEqual({
      strategy: 'residential-stable',
      geo: 'UK',
      cooldownMinutes: 60,
      failureThreshold: 3,
      sessionLimit: 5
    });
  });

  it('should handle URL input and extract domain', async () => {
    vi.mocked(etlApi.getSiteById).mockResolvedValue(mockApiResponse);
    vi.mocked(localDb.loadProxyStrategies).mockResolvedValue(mockProxyStrategies);

    const config = await getSiteConfig('https://test.com/some/path');

    expect(etlApi.getSiteById).toHaveBeenCalledWith('test.com');
    expect(config.domain).toBe('test.com');
  });

  it('should handle www prefix in domain', async () => {
    vi.mocked(etlApi.getSiteById).mockResolvedValue(mockApiResponse);
    vi.mocked(localDb.loadProxyStrategies).mockResolvedValue(mockProxyStrategies);

    const config = await getSiteConfig('https://www.test.com/path');

    expect(etlApi.getSiteById).toHaveBeenCalledWith('test.com');
  });

  it('should throw error when proxy-strategies.json is missing', async () => {
    vi.mocked(etlApi.getSiteById).mockResolvedValue(mockApiResponse);
    vi.mocked(localDb.loadProxyStrategies).mockRejectedValue(
      new Error('Failed to load database file proxy-strategies.json')
    );

    await expect(getSiteConfig('test.com')).rejects.toThrow(
      'Failed to get configuration for domain: test.com'
    );
  });

  it('should throw error when proxy strategies is invalid', async () => {
    vi.mocked(etlApi.getSiteById).mockResolvedValue(mockApiResponse);
    vi.mocked(localDb.loadProxyStrategies).mockResolvedValue(null as any);

    await expect(getSiteConfig('test.com')).rejects.toThrow(
      'Invalid proxy-strategies.json: must be an object'
    );
  });

  it('should throw error when no proxy strategy available', async () => {
    vi.mocked(etlApi.getSiteById).mockResolvedValue(mockApiResponse);
    vi.mocked(localDb.loadProxyStrategies).mockResolvedValue({}); // Empty strategies

    await expect(getSiteConfig('test.com')).rejects.toThrow(
      'No proxy strategy found for test.com and no default strategy available'
    );
  });

  it('should throw error when proxy strategy has invalid structure', async () => {
    vi.mocked(etlApi.getSiteById).mockResolvedValue(mockApiResponse);
    vi.mocked(localDb.loadProxyStrategies).mockResolvedValue({
      'test.com': {
        strategy: 'datacenter',
        // Missing required fields
      } as any
    });

    await expect(getSiteConfig('test.com')).rejects.toThrow(
      'Invalid proxy strategy structure for test.com: missing required fields'
    );
  });

  it('should handle missing browser config in API response', async () => {
    vi.mocked(etlApi.getSiteById).mockResolvedValue({
      _id: 'test.com',
      scrapeConfig: {
        // browser is missing
      }
    });
    vi.mocked(localDb.loadProxyStrategies).mockResolvedValue(mockProxyStrategies);

    const config = await getSiteConfig('test.com');

    expect(config.scraping.browser).toBeDefined();
    expect(config.scraping.browser.ignoreHttpsErrors).toBe(false);
  });

  it('should use default values when API fields are missing', async () => {
    vi.mocked(etlApi.getSiteById).mockResolvedValue({
      _id: 'test.com',
      scrapeConfig: {
        browser: {}
      }
    });
    vi.mocked(localDb.loadProxyStrategies).mockResolvedValue(mockProxyStrategies);

    const config = await getSiteConfig('test.com');

    expect(config.scraper).toBe('test.com.ts'); // Default scraper name
    expect(config.startPages).toEqual([]);
    expect(config.scraping.browser.ignoreHttpsErrors).toBe(false);
    expect(config.scraping.browser.headers).toEqual({});
  });

  it('should throw error when API response is missing scrapeConfig', async () => {
    vi.mocked(etlApi.getSiteById).mockResolvedValue({
      _id: 'test.com'
      // Missing scrapeConfig
    });

    await expect(getSiteConfig('test.com')).rejects.toThrow(
      "API response for test.com is missing 'scrapeConfig'"
    );
  });

  it('should validate all proxy strategy fields are numbers', async () => {
    vi.mocked(etlApi.getSiteById).mockResolvedValue(mockApiResponse);
    vi.mocked(localDb.loadProxyStrategies).mockResolvedValue({
      'test.com': {
        strategy: 'datacenter',
        geo: 'US',
        cooldownMinutes: '30', // String instead of number
        failureThreshold: 2,
        sessionLimit: 3
      } as any
    });

    await expect(getSiteConfig('test.com')).rejects.toThrow(
      'Invalid proxy strategy structure for test.com: missing required fields'
    );
  });
});