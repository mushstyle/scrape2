/**
 * URL utility functions
 */

/**
 * Extract domain from a URL or domain string
 * @param urlOrDomain - Full URL or domain string
 * @returns Clean domain (e.g., "example.com")
 */
export function extractDomain(urlOrDomain: string): string {
  try {
    // If it's already a clean domain (no protocol), return as-is
    if (!urlOrDomain.includes('://') && !urlOrDomain.includes('/')) {
      return urlOrDomain.toLowerCase();
    }
    
    // Parse as URL
    const url = new URL(urlOrDomain.startsWith('http') ? urlOrDomain : `https://${urlOrDomain}`);
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    // Fallback: clean up the input
    return urlOrDomain
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .toLowerCase();
  }
}

/**
 * Validate if a string is a valid URL
 * @param str - String to validate
 * @returns True if valid URL
 */
export function isValidUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure URL has protocol
 * @param url - URL that may or may not have protocol
 * @returns URL with https:// protocol
 */
export function ensureProtocol(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  return `https://${url}`;
}

/**
 * Get base URL from a full URL
 * @param url - Full URL
 * @returns Base URL (protocol + domain)
 */
export function getBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}