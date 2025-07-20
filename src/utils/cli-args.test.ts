import { describe, it, expect } from 'vitest';
import { parseArgs } from './cli-args.js';

describe('parseArgs', () => {
  it('should parse command correctly', () => {
    const result = parseArgs(['paginate']);
    expect(result.command).toBe('paginate');
    expect(result.options).toEqual({});
  });

  it('should parse --sites with equals format', () => {
    const result = parseArgs(['paginate', '--sites=site1.com,site2.com']);
    expect(result.options.sites).toEqual(['site1.com', 'site2.com']);
  });

  it('should parse --sites with space format', () => {
    const result = parseArgs(['paginate', '--sites', 'site1.com,site2.com']);
    expect(result.options.sites).toEqual(['site1.com', 'site2.com']);
  });

  it('should parse --exclude with equals format', () => {
    const result = parseArgs(['paginate', '--exclude=site1.com,site2.com']);
    expect(result.options.exclude).toEqual(['site1.com', 'site2.com']);
  });

  it('should parse --exclude with space format', () => {
    const result = parseArgs(['paginate', '--exclude', 'site1.com,site2.com']);
    expect(result.options.exclude).toEqual(['site1.com', 'site2.com']);
  });

  it('should parse both --sites and --exclude', () => {
    const result = parseArgs(['paginate', '--sites', 'site1.com,site2.com,site3.com', '--exclude=site2.com']);
    expect(result.options.sites).toEqual(['site1.com', 'site2.com', 'site3.com']);
    expect(result.options.exclude).toEqual(['site2.com']);
  });

  it('should parse --since with equals format', () => {
    const result = parseArgs(['paginate', '--since=1d']);
    expect(result.options.since).toBeInstanceOf(Date);
  });

  it('should parse --since with space format', () => {
    const result = parseArgs(['paginate', '--since', '2h']);
    expect(result.options.since).toBeInstanceOf(Date);
  });

  it('should parse numeric options', () => {
    const result = parseArgs(['paginate', '--instance-limit=5', '--max-pages', '10']);
    expect(result.options.instanceLimit).toBe(5);
    expect(result.options.maxPages).toBe(10);
  });

  it('should parse boolean flags', () => {
    const result = parseArgs(['paginate', '--disable-cache', '--no-save', '--force']);
    expect(result.options.disableCache).toBe(true);
    expect(result.options.noSave).toBe(true);
    expect(result.options.force).toBe(true);
  });

  it('should parse multiple options together', () => {
    const result = parseArgs([
      'items',
      '--sites=site1.com,site2.com',
      '--exclude', 'site3.com',
      '--since', '1d',
      '--instance-limit=20',
      '--no-save',
      '--force'
    ]);
    
    expect(result.command).toBe('items');
    expect(result.options.sites).toEqual(['site1.com', 'site2.com']);
    expect(result.options.exclude).toEqual(['site3.com']);
    expect(result.options.since).toBeInstanceOf(Date);
    expect(result.options.instanceLimit).toBe(20);
    expect(result.options.noSave).toBe(true);
    expect(result.options.force).toBe(true);
  });

  it('should trim whitespace from site names', () => {
    const result = parseArgs(['paginate', '--sites=site1.com, site2.com , site3.com']);
    expect(result.options.sites).toEqual(['site1.com', 'site2.com', 'site3.com']);
  });

  it('should handle empty exclude list', () => {
    const result = parseArgs(['paginate', '--exclude=']);
    expect(result.options.exclude).toEqual(['']);
  });
});