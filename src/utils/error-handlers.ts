import { logger } from './logger.js';

const log = logger.createContext('error-handlers');

/**
 * Install global process error handlers to prevent crashes from unhandled errors
 * This should be called once at application startup
 */
export function installGlobalErrorHandlers(): void {
  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    // Check if it's a Playwright browser error
    const message = reason?.message || String(reason);
    if (isBrowserError(message)) {
      log.error('Unhandled browser error (non-fatal):', message);
      // Don't exit for browser errors - they're expected when sessions expire
      return;
    }
    
    // For other unhandled rejections, log and continue
    log.error('Unhandled Promise Rejection:', reason);
    log.error('Promise:', promise);
    // In production, you might want to send this to an error tracking service
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (err: Error, origin: string) => {
    // Check if it's a browser error
    if (isBrowserError(err.message)) {
      log.error('Uncaught browser error (non-fatal):', err.message);
      // Don't exit for browser errors
      return;
    }
    
    // For other uncaught exceptions, this is fatal
    log.error('FATAL: Uncaught Exception:', err);
    log.error('Origin:', origin);
    // Must exit - the process is in an undefined state
    process.exit(1);
  });

  // Monitor exceptions without changing behavior (for logging)
  process.on('uncaughtExceptionMonitor', (err: Error, origin: string) => {
    if (isBrowserError(err.message)) {
      log.debug('Browser error monitored:', err.message);
    } else {
      log.error('Exception monitored:', err.message, 'Origin:', origin);
    }
  });

  log.normal('Global error handlers installed');
}

/**
 * Check if an error is related to browser/page being closed
 * These are expected errors when sessions expire and should not crash the process
 */
export function isBrowserError(message: string | null | undefined): boolean {
  if (!message) return false;
  
  const lowerMessage = message.toLowerCase();
  return lowerMessage.includes('target page, context or browser has been closed') ||
         lowerMessage.includes('browser has been closed') ||
         lowerMessage.includes('context has been closed') ||
         lowerMessage.includes('target closed') ||
         lowerMessage.includes('session not found') ||
         lowerMessage.includes('session expired') ||
         lowerMessage.includes('websocket') ||
         lowerMessage.includes('disconnected') ||
         lowerMessage.includes('connection closed') ||
         lowerMessage.includes('browser is closed') ||
         lowerMessage.includes('execution context was destroyed') ||
         lowerMessage.includes('page has been closed');
}

/**
 * Wrap an async function to catch and handle browser errors gracefully
 */
export function withBrowserErrorHandling<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  context: string
): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args);
    } catch (error: any) {
      if (isBrowserError(error.message)) {
        log.error(`Browser error in ${context}:`, error.message);
        // Re-throw to let the caller handle it (e.g., retry logic)
        throw error;
      }
      // Re-throw non-browser errors
      throw error;
    }
  }) as T;
}