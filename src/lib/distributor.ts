import type { ScrapeRunItem } from '../types/scrape-run.js';
import type { SiteConfig } from '../types/site-config-types.js';

export interface UrlSessionPair {
  url: string;
  sessionId: string;
}

export interface SessionInfo {
  id: string;
  proxyType?: 'residential' | 'datacenter' | 'none';
  proxyId?: string;
}

/**
 * Simple linear distributor that matches URLs to sessions
 * 
 * Algorithm:
 * - Iterate through URLs
 * - For each URL, iterate through sessions
 * - Take first session that works for URL based on site proxy requirements
 * - Return URL + Session pairs
 * 
 * @param items - Array of ScrapeRunItems to distribute
 * @param sessions - Array of session info with proxy details
 * @param siteConfig - Site configuration with proxy requirements
 * @returns Array of URL-Session pairs
 */
export function itemsToSessions(
  items: ScrapeRunItem[],
  sessions: SessionInfo[],
  siteConfig?: SiteConfig
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
      console.warn(`No suitable session found for URL: ${item.url}`);
    }
  }
  
  return results;
}

/**
 * Check if a session's proxy configuration matches the site's requirements
 */
function sessionWorksForUrl(session: SessionInfo, siteConfig?: SiteConfig): boolean {
  // If no site config provided, any session works
  if (!siteConfig || !siteConfig.proxy) {
    return true;
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