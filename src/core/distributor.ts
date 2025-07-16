import type { ScrapeTarget } from '../types/scrape-target.js';
import type { SiteConfig } from '../types/site-config-types.js';
import { logger } from '../utils/logger.js';

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
 * Simple linear distributor that matches URLs to sessions with 1:1 mapping
 * 
 * Algorithm:
 * - Each session can only be used once
 * - Iterate through URLs
 * - For each URL, find its site config based on domain
 * - Iterate through available sessions (not yet used)
 * - Take first session that works for URL based on site proxy requirements and blocked proxies
 * - Mark session as used
 * - Return URL + Session pairs (max N pairs where N = number of sessions)
 * 
 * @param targets - Array of ScrapeTargets to distribute
 * @param sessions - Array of session info with proxy details
 * @param siteConfigs - Array of site configurations with proxy requirements and blocked proxy IDs
 * @returns Array of URL-Session pairs with unique sessions (max length = sessions.length)
 */
export function itemsToSessions(
  targets: ScrapeTarget[],
  sessions: SessionInfo[],
  siteConfigs: SiteConfigWithBlockedProxies[] = []
): UrlSessionPair[] {
  // Filter out completed targets (done === true)
  const pendingTargets = targets.filter(target => !target.done);
  
  // If no sessions or no pending targets, return empty array
  if (sessions.length === 0 || pendingTargets.length === 0) {
    return [];
  }
  
  const results: UrlSessionPair[] = [];
  const usedSessionIds = new Set<string>();
  
  // Iterate through URLs
  for (const target of pendingTargets) {
    // Stop if we've used all sessions
    if (usedSessionIds.size >= sessions.length) {
      break;
    }
    
    // Find site config for this URL's domain
    const urlDomain = extractDomain(target.url);
    const siteConfig = siteConfigs.find(config => config.domain === urlDomain);
    
    // Iterate through sessions to find first unused one that works
    for (const session of sessions) {
      if (!usedSessionIds.has(session.id) && sessionWorksForUrl(session, siteConfig)) {
        results.push({
          url: target.url,
          sessionId: session.id
        });
        usedSessionIds.add(session.id);
        break;
      }
    }
  }
  
  log.debug(`Matched ${results.length} URL-session pairs from ${sessions.length} available sessions`);
  
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

/**
 * Double-pass matcher algorithm for efficient URL-session distribution
 * 
 * This pure function implements a two-pass matching strategy:
 * 1. First pass: Match URLs to existing sessions
 * 2. Identify excess sessions and needed sessions
 * 3. Second pass: Match URLs to all sessions (including newly created ones)
 * 
 * @param targets - Targets to distribute
 * @param initialSessions - Initially available sessions
 * @param finalSessions - All sessions after creation/termination
 * @param siteConfigs - Site configurations with proxy requirements
 * @returns Object with first pass results, excess sessions, and final results
 */
export function doublePassMatcher(
  targets: ScrapeTarget[],
  initialSessions: SessionInfo[],
  finalSessions: SessionInfo[],
  siteConfigs: SiteConfigWithBlockedProxies[] = []
): {
  firstPassMatched: UrlSessionPair[];
  excessSessions: SessionInfo[];
  finalMatched: UrlSessionPair[];
} {
  // First pass with initial sessions
  const firstPassMatched = itemsToSessions(targets, initialSessions, siteConfigs);
  
  // Identify excess sessions (not used in first pass)
  const usedSessionIds = new Set(firstPassMatched.map(pair => pair.sessionId));
  const excessSessions = initialSessions.filter(session => !usedSessionIds.has(session.id));
  
  // Second pass with final sessions (after creation/termination)
  const finalMatched = itemsToSessions(targets, finalSessions, siteConfigs);
  
  return {
    firstPassMatched,
    excessSessions,
    finalMatched
  };
}