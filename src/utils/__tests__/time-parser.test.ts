import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseTimeDuration, formatDate } from '../time-parser.js';

describe('Time Parser', () => {
  beforeEach(() => {
    // Mock current time for consistent testing
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('parseTimeDuration', () => {
    it('should parse days correctly', () => {
      const result = parseTimeDuration('1d');
      expect(result.toISOString()).toBe('2024-01-14T12:00:00.000Z');
    });

    it('should parse multiple days', () => {
      const result = parseTimeDuration('7d');
      expect(result.toISOString()).toBe('2024-01-08T12:00:00.000Z');
    });

    it('should parse hours correctly', () => {
      const result = parseTimeDuration('48h');
      expect(result.toISOString()).toBe('2024-01-13T12:00:00.000Z');
    });

    it('should parse weeks correctly', () => {
      const result = parseTimeDuration('1w');
      expect(result.toISOString()).toBe('2024-01-08T12:00:00.000Z');
    });

    it('should parse minutes correctly', () => {
      const result = parseTimeDuration('30m');
      expect(result.toISOString()).toBe('2024-01-15T11:30:00.000Z');
    });

    it('should parse seconds correctly', () => {
      const result = parseTimeDuration('60s');
      expect(result.toISOString()).toBe('2024-01-15T11:59:00.000Z');
    });

    it('should throw error for invalid format', () => {
      expect(() => parseTimeDuration('invalid')).toThrow('Invalid duration format');
      expect(() => parseTimeDuration('1')).toThrow('Invalid duration format');
      expect(() => parseTimeDuration('d')).toThrow('Invalid duration format');
      expect(() => parseTimeDuration('1x')).toThrow('Invalid duration format');
    });
  });

  describe('formatDate', () => {
    it('should format date correctly', () => {
      const date = new Date('2024-01-15T12:30:45.000Z');
      expect(formatDate(date)).toBe('2024-01-15 12:30:45 UTC');
    });
  });
});