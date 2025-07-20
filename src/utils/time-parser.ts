/**
 * Parse time duration strings into Date objects
 * Supports formats like: 1d, 48h, 1w, 2m (minutes), 30s
 */
export function parseTimeDuration(duration: string): Date {
  const now = new Date();
  
  // Match number followed by unit
  const match = duration.match(/^(\d+)([dhwms])$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}. Use formats like 1d, 48h, 1w, 30m, 60s`);
  }
  
  const [, value, unit] = match;
  const amount = parseInt(value, 10);
  
  switch (unit) {
    case 'd': // days
      return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
    case 'h': // hours
      return new Date(now.getTime() - amount * 60 * 60 * 1000);
    case 'w': // weeks
      return new Date(now.getTime() - amount * 7 * 24 * 60 * 60 * 1000);
    case 'm': // minutes
      return new Date(now.getTime() - amount * 60 * 1000);
    case 's': // seconds
      return new Date(now.getTime() - amount * 1000);
    default:
      throw new Error(`Unknown time unit: ${unit}`);
  }
}

/**
 * Format a Date for display
 */
export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
}