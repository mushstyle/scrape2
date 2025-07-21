import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isBrowserError } from '../src/utils/error-handlers.js';

describe('Error Handlers', () => {
  describe('isBrowserError', () => {
    it('should identify browser closed errors', () => {
      const browserErrors = [
        'Target page, context or browser has been closed',
        'Browser has been closed',
        'Context has been closed',
        'Target closed',
        'Session not found',
        'Session expired',
        'WebSocket error',
        'Disconnected from browser',
        'Connection closed',
        'Browser is closed',
        'Execution context was destroyed',
        'Page has been closed'
      ];

      for (const error of browserErrors) {
        expect(isBrowserError(error)).toBe(true);
        expect(isBrowserError(error.toLowerCase())).toBe(true);
        expect(isBrowserError(error.toUpperCase())).toBe(true);
      }
    });

    it('should not identify non-browser errors', () => {
      const nonBrowserErrors = [
        'Network error',
        'Timeout',
        'File not found',
        'Invalid URL',
        'Permission denied'
      ];

      for (const error of nonBrowserErrors) {
        expect(isBrowserError(error)).toBe(false);
      }
    });

    it('should handle empty or null messages', () => {
      expect(isBrowserError('')).toBe(false);
      expect(isBrowserError(null as any)).toBe(false);
      expect(isBrowserError(undefined as any)).toBe(false);
    });
  });
});