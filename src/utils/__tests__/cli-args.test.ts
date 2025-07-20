import { describe, test, expect, vi } from 'vitest';
import { parseArgs } from '../cli-args.js';

// Mock process.exit to prevent test termination
vi.spyOn(process, 'exit').mockImplementation(() => {
  throw new Error('process.exit called');
});

describe('parseArgs', () => {
  test('should parse command', () => {
    const result = parseArgs(['paginate']);
    expect(result.command).toBe('paginate');
    expect(result.options).toEqual({});
  });

  describe('--sites parameter', () => {
    test('should parse --sites=value format', () => {
      const result = parseArgs(['paginate', '--sites=site1.com,site2.com']);
      expect(result.options.sites).toEqual(['site1.com', 'site2.com']);
    });

    test('should parse --sites value format', () => {
      const result = parseArgs(['paginate', '--sites', 'site1.com,site2.com']);
      expect(result.options.sites).toEqual(['site1.com', 'site2.com']);
    });

    test('should trim whitespace from sites', () => {
      const result = parseArgs(['paginate', '--sites=site1.com, site2.com ,  site3.com']);
      expect(result.options.sites).toEqual(['site1.com', 'site2.com', 'site3.com']);
    });
  });

  describe('--since parameter', () => {
    test('should parse --since=value format', () => {
      const result = parseArgs(['paginate', '--since=1d']);
      expect(result.options.since).toBeInstanceOf(Date);
      // Should be approximately 1 day ago
      const dayAgo = new Date();
      dayAgo.setDate(dayAgo.getDate() - 1);
      expect(Math.abs(result.options.since.getTime() - dayAgo.getTime())).toBeLessThan(5000); // Within 5 seconds
    });

    test('should parse --since value format', () => {
      const result = parseArgs(['paginate', '--since', '24h']);
      expect(result.options.since).toBeInstanceOf(Date);
    });

    test('should handle invalid since value', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      expect(() => parseArgs(['paginate', '--since=invalid'])).toThrow('process.exit called');
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Error parsing --since:'));
      
      consoleError.mockRestore();
    });
  });

  describe('numeric parameters', () => {
    test('should parse --instance-limit with equals', () => {
      const result = parseArgs(['paginate', '--instance-limit=5']);
      expect(result.options.instanceLimit).toBe(5);
    });

    test('should parse --instance-limit with space', () => {
      const result = parseArgs(['paginate', '--instance-limit', '10']);
      expect(result.options.instanceLimit).toBe(10);
    });

    test('should parse --max-pages', () => {
      const result = parseArgs(['paginate', '--max-pages=20']);
      expect(result.options.maxPages).toBe(20);
    });

    test('should parse --item-limit', () => {
      const result = parseArgs(['items', '--item-limit', '50']);
      expect(result.options.itemLimit).toBe(50);
    });

    test('should parse --cache-size-mb', () => {
      const result = parseArgs(['paginate', '--cache-size-mb=200']);
      expect(result.options.cacheSizeMB).toBe(200);
    });

    test('should parse --cache-ttl-seconds', () => {
      const result = parseArgs(['paginate', '--cache-ttl-seconds', '600']);
      expect(result.options.cacheTTLSeconds).toBe(600);
    });

    test('should parse --session-timeout', () => {
      const result = parseArgs(['paginate', '--session-timeout=120']);
      expect(result.options.sessionTimeout).toBe(120);
    });

    test('should parse --max-retries', () => {
      const result = parseArgs(['paginate', '--max-retries', '3']);
      expect(result.options.maxRetries).toBe(3);
    });
  });

  describe('boolean flags', () => {
    test('should parse --disable-cache', () => {
      const result = parseArgs(['paginate', '--disable-cache']);
      expect(result.options.disableCache).toBe(true);
    });

    test('should parse --no-save', () => {
      const result = parseArgs(['paginate', '--no-save']);
      expect(result.options.noSave).toBe(true);
    });

    test('should parse --local-headless', () => {
      const result = parseArgs(['paginate', '--local-headless']);
      expect(result.options.localHeadless).toBe(true);
    });

    test('should parse --local-headed', () => {
      const result = parseArgs(['paginate', '--local-headed']);
      expect(result.options.localHeaded).toBe(true);
    });

    test('should parse --force', () => {
      const result = parseArgs(['paginate', '--force']);
      expect(result.options.force).toBe(true);
    });
  });

  describe('multiple parameters', () => {
    test('should parse multiple parameters correctly', () => {
      const result = parseArgs([
        'paginate',
        '--sites=site1.com,site2.com',
        '--since', '1d',
        '--instance-limit=5',
        '--no-save',
        '--disable-cache'
      ]);

      expect(result.command).toBe('paginate');
      expect(result.options.sites).toEqual(['site1.com', 'site2.com']);
      expect(result.options.since).toBeInstanceOf(Date);
      expect(result.options.instanceLimit).toBe(5);
      expect(result.options.noSave).toBe(true);
      expect(result.options.disableCache).toBe(true);
    });

    test('should handle mixed formats', () => {
      const result = parseArgs([
        'items',
        '--sites', 'site1.com',
        '--item-limit=100',
        '--cache-size-mb', '50',
        '--local-headed'
      ]);

      expect(result.command).toBe('items');
      expect(result.options.sites).toEqual(['site1.com']);
      expect(result.options.itemLimit).toBe(100);
      expect(result.options.cacheSizeMB).toBe(50);
      expect(result.options.localHeaded).toBe(true);
    });
  });

  describe('edge cases', () => {
    test('should ignore unknown parameters', () => {
      const result = parseArgs(['paginate', '--unknown=value', '--another']);
      expect(result.options).toEqual({});
    });

    test('should handle parameters at end without values', () => {
      const result = parseArgs(['paginate', '--sites']);
      expect(result.options.sites).toBeUndefined();
    });

    test('should handle empty args array', () => {
      const result = parseArgs([]);
      expect(result.command).toBeUndefined();
      expect(result.options).toEqual({});
    });
  });
});