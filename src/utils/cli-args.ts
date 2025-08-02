import { parseTimeDuration } from './time-parser.js';

export interface ParsedArgs {
  command: string;
  options: Record<string, any>;
}

/**
 * Parse command line arguments supporting both formats:
 * - --param=value
 * - --param value
 * 
 * Boolean flags (like --no-save) don't take values.
 */
export function parseArgs(args: string[]): ParsedArgs {
  const command = args[0];
  const options: Record<string, any> = {};
  
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    
    if (arg.startsWith('--sites=')) {
      options.sites = arg.replace('--sites=', '').split(',').map(s => s.trim());
    } else if (arg === '--sites' && i + 1 < args.length) {
      options.sites = args[++i].split(',').map(s => s.trim());
    } else if (arg.startsWith('--since=')) {
      try {
        options.since = parseTimeDuration(arg.replace('--since=', ''));
      } catch (error) {
        console.error(`Error parsing --since: ${error.message}`);
        process.exit(1);
      }
    } else if (arg === '--since' && i + 1 < args.length) {
      try {
        options.since = parseTimeDuration(args[++i]);
      } catch (error) {
        console.error(`Error parsing --since: ${error.message}`);
        process.exit(1);
      }
    } else if (arg.startsWith('--instance-limit=')) {
      options.instanceLimit = parseInt(arg.replace('--instance-limit=', ''), 10);
    } else if (arg === '--instance-limit' && i + 1 < args.length) {
      options.instanceLimit = parseInt(args[++i], 10);
    } else if (arg.startsWith('--max-pages=')) {
      options.maxPages = parseInt(arg.replace('--max-pages=', ''), 10);
    } else if (arg === '--max-pages' && i + 1 < args.length) {
      options.maxPages = parseInt(args[++i], 10);
    } else if (arg.startsWith('--item-limit=')) {
      options.itemLimit = parseInt(arg.replace('--item-limit=', ''), 10);
    } else if (arg === '--item-limit' && i + 1 < args.length) {
      options.itemLimit = parseInt(args[++i], 10);
    } else if (arg === '--disable-cache') {
      options.disableCache = true;
    } else if (arg.startsWith('--cache-size-mb=')) {
      options.cacheSizeMB = parseInt(arg.replace('--cache-size-mb=', ''), 10);
    } else if (arg === '--cache-size-mb' && i + 1 < args.length) {
      options.cacheSizeMB = parseInt(args[++i], 10);
    } else if (arg.startsWith('--cache-ttl-seconds=')) {
      options.cacheTTLSeconds = parseInt(arg.replace('--cache-ttl-seconds=', ''), 10);
    } else if (arg === '--cache-ttl-seconds' && i + 1 < args.length) {
      options.cacheTTLSeconds = parseInt(args[++i], 10);
    } else if (arg === '--no-save') {
      options.noSave = true;
    } else if (arg === '--local-headless') {
      options.localHeadless = true;
    } else if (arg === '--local-headed') {
      options.localHeaded = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg.startsWith('--session-timeout=')) {
      options.sessionTimeout = parseInt(arg.replace('--session-timeout=', ''), 10);
    } else if (arg === '--session-timeout' && i + 1 < args.length) {
      options.sessionTimeout = parseInt(args[++i], 10);
    } else if (arg.startsWith('--max-retries=')) {
      options.maxRetries = parseInt(arg.replace('--max-retries=', ''), 10);
    } else if (arg === '--max-retries' && i + 1 < args.length) {
      options.maxRetries = parseInt(args[++i], 10);
    } else if (arg.startsWith('--exclude=')) {
      options.exclude = arg.replace('--exclude=', '').split(',').map(s => s.trim());
    } else if (arg === '--exclude' && i + 1 < args.length) {
      options.exclude = args[++i].split(',').map(s => s.trim());
    } else if (arg === '--retry-failed') {
      options.retryFailedItems = true;
    } else if (arg === '--retry-invalid') {
      options.retryInvalidItems = true;
    } else if (arg === '--retry-all') {
      options.retryAllItems = true;
    } else if (arg === '--no-block-images') {
      options.blockImages = false;
    } else if (arg === '--block-images') {
      options.blockImages = true;
    }
  }
  
  return { command, options };
}