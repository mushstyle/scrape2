import type { ScrapeRunItem } from '../types/scrape-run.js';
import type { SiteConfig } from '../types/site-config-types.js';
import { logger } from './logger.js';

const log = logger.createContext('distributor');

export interface UrlSessionPair {
  url: string;
  sessionId: string;
}

export interface SessionInfo {
  id: string;
  proxyType?: 'residential' | 'datacenter' | 'none';
  proxyId?: string;
  proxyGeo?: string;  // 2-letter ISO code: 'US', 'UK', etc.
}

export interface SiteConfigWithBlockedProxies extends SiteConfig {
  blockedProxyIds?: string[];
}

/**
 * Simple linear distributor that matches URLs to sessions
 * 
 * Algorithm:
 * - Iterate through URLs
 * - For each URL, find its site config based on domain
 * - Iterate through sessions
 * - Take first session that works for URL based on site proxy requirements and blocked proxies
 * - Return URL + Session pairs
 * 
 * @param items - Array of ScrapeRunItems to distribute
 * @param sessions - Array of session info with proxy details
 * @param siteConfigs - Array of site configurations with proxy requirements and blocked proxy IDs
 * @returns Array of URL-Session pairs
 */
export function itemsToSessions(
  items: ScrapeRunItem[],
  sessions: SessionInfo[],
  siteConfigs: SiteConfigWithBlockedProxies[] = []
): UrlSessionPair[] {
  // Filter out completed items (done === true)
  const pendingItems = items.filter(item => !item.done);
  
  // If no sessions or no pending items, return empty array
  if (sessions.length === 0 || pendingItems.length === 0) {
    return [];
  }
  
  const results: UrlSessionPair[] = [];
  
  // Iterate through URLs
  for (const item of pendingItems) {
    let matched = false;
    
    // Find site config for this URL's domain
    const urlDomain = extractDomain(item.url);
    const siteConfig = siteConfigs.find(config => config.domain === urlDomain);
    
    // Iterate through sessions to find first one that works
    for (const session of sessions) {
      if (sessionWorksForUrl(session, siteConfig)) {
        results.push({
          url: item.url,
          sessionId: session.id
        });
        matched = true;
        break;
      }
    }
    
    // If no matching session found, skip this URL
    if (!matched) {
      log.debug(`No suitable session found for URL: ${item.url}`);
    }
  }
  
  return results;
}

/**
 * Check if a session's proxy configuration matches the site's requirements
 */
function sessionWorksForUrl(session: SessionInfo, siteConfig?: SiteConfigWithBlockedProxies): boolean {
  // If no site config provided, any session works
  if (!siteConfig || !siteConfig.proxy) {
    return true;
  }
  
  // Check if session's proxy is in the blocked list
  if (session.proxyId && siteConfig.blockedProxyIds?.includes(session.proxyId)) {
    return false;
  }
  
  // Check geo match if required
  if (siteConfig.proxy.geo && session.proxyGeo && session.proxyGeo !== siteConfig.proxy.geo) {
    return false;
  }
  
  const requiredStrategy = siteConfig.proxy.strategy;
  
  // Map proxy strategies to session proxy types
  switch (requiredStrategy) {
    case 'none':
      return session.proxyType === 'none' || !session.proxyType;
      
    case 'datacenter':
      return session.proxyType === 'datacenter';
      
    case 'residential-stable':
    case 'residential-rotating':
      return session.proxyType === 'residential';
      
    case 'datacenter-to-residential':
      // This strategy can use either datacenter or residential
      return session.proxyType === 'datacenter' || session.proxyType === 'residential';
      
    default:
      // Unknown strategy, be conservative and reject
      return false;
  }
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    // Remove 'www.' prefix if present
    return urlObj.hostname.replace(/^www\./, '');
  } catch (error) {
    log.debug(`Failed to parse URL: ${url}`);
    return '';
  }
}