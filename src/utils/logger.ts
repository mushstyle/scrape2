export enum LogLevel {
  QUIET = 0,
  NORMAL = 1,
  VERBOSE = 2,
  DEBUG = 3
}

interface LoggerConfig {
  level: LogLevel;
  context?: string;
  showTimestamps?: boolean;
  colorize?: boolean;
}

class Logger {
  private static instance: Logger;
  private config: LoggerConfig = {
    level: LogLevel.NORMAL,
    showTimestamps: false,
    colorize: true
  };

  private constructor() {}

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  getLevel(): LogLevel {
    return this.config.level;
  }

  setConfig(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // Create a contextual logger
  createContext(context: string): ContextualLogger {
    return new ContextualLogger(context, this);
  }

  // Core logging methods
  log(level: LogLevel, message: string, context?: string, data?: any): void {
    if (level > this.config.level) return;

    const prefix = context ? `[${context}] ` : '';
    const formattedMessage = `${prefix}${message}`;

    // In quiet mode, only show essential completion messages
    if (this.config.level === LogLevel.QUIET) {
      if (level === LogLevel.QUIET) {
        console.log(formattedMessage);
      }
      return;
    }

    console.log(formattedMessage);
    if (data !== undefined) {
      console.log(data);
    }
  }

  // Convenience methods
  quiet(message: string, context?: string, data?: any): void {
    this.log(LogLevel.QUIET, message, context, data);
  }

  normal(message: string, context?: string, data?: any): void {
    this.log(LogLevel.NORMAL, message, context, data);
  }

  verbose(message: string, context?: string, data?: any): void {
    this.log(LogLevel.VERBOSE, message, context, data);
  }

  debug(message: string, context?: string, data?: any): void {
    this.log(LogLevel.DEBUG, message, context, data);
  }

  error(message: string, context?: string, data?: any): void {
    // Errors always show unless in quiet mode
    if (this.config.level > LogLevel.QUIET) {
      const prefix = context ? `[${context}] ` : '';
      console.error(`${prefix}${message}`);
      if (data !== undefined) {
        console.error(data);
      }
    }
  }

  // Progress indicators
  success(site: string, message: string): void {
    if (this.config.level >= LogLevel.NORMAL) {
      console.log(`✓ ${site.padEnd(20)} ${message}`);
    }
  }

  failure(site: string, message: string): void {
    if (this.config.level >= LogLevel.NORMAL) {
      console.log(`✗ ${site.padEnd(20)} ${message}`);
    }
  }

  processing(site: string, message: string): void {
    if (this.config.level >= LogLevel.NORMAL) {
      console.log(`⏳ ${site.padEnd(20)} ${message}`);
    }
  }

  skip(site: string, message: string): void {
    if (this.config.level >= LogLevel.NORMAL) {
      console.log(`⏸  ${site.padEnd(20)} ${message}`);
    }
  }

  // Progress bar placeholder
  progressBar(current: number, total: number, message?: string): void {
    if (this.config.level >= LogLevel.NORMAL && this.config.level < LogLevel.DEBUG) {
      const percentage = Math.floor((current / total) * 100);
      const filled = Math.floor(percentage / 2.5);
      const bar = '━'.repeat(filled) + '╺'.repeat(40 - filled);
      const msg = message || `${current}/${total} complete`;
      process.stdout.write(`\r${bar} ${percentage}% | ${msg}`);
    }
  }

  // Separator line
  separator(): void {
    if (this.config.level >= LogLevel.NORMAL && this.config.level < LogLevel.DEBUG) {
      console.log('━'.repeat(50));
    }
  }
}

// Contextual logger for component-specific logging
export class ContextualLogger {
  constructor(
    private context: string,
    private logger: Logger
  ) {}

  quiet(message: string, data?: any): void {
    this.logger.quiet(message, this.context, data);
  }

  normal(message: string, data?: any): void {
    this.logger.normal(message, this.context, data);
  }

  verbose(message: string, data?: any): void {
    this.logger.verbose(message, this.context, data);
  }

  debug(message: string, data?: any): void {
    this.logger.debug(message, this.context, data);
  }

  error(message: string, data?: any): void {
    this.logger.error(message, this.context, data);
  }

  // Log only at a specific level
  log(message: string, data?: any): void {
    this.logger.normal(message, this.context, data);
  }
}

// Export singleton instance
export const logger = Logger.getInstance();

// Helper to parse log level from string
export function parseLogLevel(level: string | undefined): LogLevel {
  if (!level) return LogLevel.NORMAL;
  
  switch (level.toLowerCase()) {
    case 'quiet':
    case 'q':
      return LogLevel.QUIET;
    case 'verbose':
    case 'v':
      return LogLevel.VERBOSE;
    case 'debug':
    case 'd':
      return LogLevel.DEBUG;
    default:
      return LogLevel.NORMAL;
  }
}

// Format helpers
export const formatTime = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
};

export const formatProgress = (current: number, total: number): string => {
  const percentage = Math.floor((current / total) * 100);
  return `${current}/${total} (${percentage}%)`;
};

export const formatETA = (itemsProcessed: number, totalItems: number, elapsedMs: number): string => {
  if (itemsProcessed === 0) return 'calculating...';
  
  const itemsPerMs = itemsProcessed / elapsedMs;
  const remainingItems = totalItems - itemsProcessed;
  const remainingMs = remainingItems / itemsPerMs;
  
  return formatTime(remainingMs);
};