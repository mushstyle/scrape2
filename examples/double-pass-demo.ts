#!/usr/bin/env tsx --env-file=.env

/**
 * Double-Pass Matcher Demo
 * 
 * This example demonstrates the doublePassMatcher pure function
 * from core/distributor.ts using proper architecture patterns.
 */

import { logger } from '../src/utils/logger.js';
import { doublePassMatcher, itemsToSessions } from '../src/core/distributor.js';
import { SessionManager } from '../src/services/session-manager.js';
import { SiteManager } from '../src/services/site-manager.js';
import type { SessionInfo, SiteConfigWithBlockedProxies } from '../src/core/distributor.js';
import type { ScrapeTarget } from '../src/types/scrape-target.js';

const log = logger.createContext('double-pass-demo');

async function demonstrateDoublePassMatcher() {
  log.normal('=== Double-Pass Matcher Demo ===\n');

  // 1. Initialize services
  const sessionManager = new SessionManager({
    sessionLimit: 5,
    provider: 'local'
  });

  const siteManager = new SiteManager();
  await siteManager.loadSites();

  // 2. Create some initial sessions
  log.normal('Creating 2 initial sessions...');
  const session1 = await sessionManager.createSession();
  const session2 = await sessionManager.createSession();
  
  const initialSessions = await sessionManager.getActiveSessions();
  
  // Convert to SessionInfo format (this would normally be done by a service method)
  const initialSessionInfos: SessionInfo[] = initialSessions.map((session, index) => ({
    id: `session-${index + 1}`,
    proxyType: 'datacenter' as const,
    proxyGeo: 'US'
  }));

  // 3. Create mock targets to distribute
  const targets: ScrapeTarget[] = [
    { url: 'https://example.com/1', done: false, failed: false, invalid: false },
    { url: 'https://example.com/2', done: false, failed: false, invalid: false },
    { url: 'https://example.com/3', done: false, failed: false, invalid: false },
    { url: 'https://example.com/4', done: false, failed: false, invalid: false },
    { url: 'https://example.com/5', done: false, failed: false, invalid: false }
  ];

  // 4. Get site configs
  const siteConfigs: SiteConfigWithBlockedProxies[] = siteManager.getSiteConfigs()
    .filter(config => config.domain === 'example.com')
    .slice(0, 1); // Just use one for demo

  // If no example.com config, create a mock one
  if (siteConfigs.length === 0) {
    siteConfigs.push({
      domain: 'example.com',
      scraper: 'example.ts',
      startPages: [],
      scraping: { browser: { ignoreHttpsErrors: false, headers: {} } },
      proxy: { strategy: 'datacenter', geo: 'US', sessionLimit: 3 }
    });
  }

  // 5. Simulate adding more sessions (as if we created them after first pass)
  log.normal('\nSimulating session creation after first pass...');
  const session3 = await sessionManager.createSession();
  
  const finalSessions = await sessionManager.getActiveSessions();
  const finalSessionInfos: SessionInfo[] = finalSessions.map((session, index) => ({
    id: `session-${index + 1}`,
    proxyType: 'datacenter' as const,
    proxyGeo: 'US'
  }));

  // 6. Run the double-pass matcher
  log.normal('\n=== Running Double-Pass Matcher ===');
  
  const result = doublePassMatcher(
    targets,
    initialSessionInfos,
    finalSessionInfos,
    siteConfigs
  );

  // 7. Display results
  log.normal('\nFirst Pass Results:');
  log.normal(`  Matched ${result.firstPassMatched.length} URL-session pairs`);
  result.firstPassMatched.forEach(pair => {
    log.normal(`    ${pair.url} → ${pair.sessionId}`);
  });

  log.normal('\nExcess Sessions:');
  log.normal(`  Found ${result.excessSessions.length} excess sessions`);
  result.excessSessions.forEach(session => {
    log.normal(`    ${session.id} (${session.proxyType}/${session.proxyGeo || 'any'})`);
  });

  log.normal('\nFinal Results (after session reallocation):');
  log.normal(`  Matched ${result.finalMatched.length} URL-session pairs`);
  result.finalMatched.forEach(pair => {
    log.normal(`    ${pair.url} → ${pair.sessionId}`);
  });

  // 8. Compare efficiency
  log.normal('\n=== Efficiency Analysis ===');
  log.normal(`Items to process: ${items.length}`);
  log.normal(`Initial sessions: ${initialSessionInfos.length}`);
  log.normal(`Final sessions: ${finalSessionInfos.length}`);
  log.normal(`First pass efficiency: ${(result.firstPassMatched.length / initialSessionInfos.length * 100).toFixed(1)}%`);
  log.normal(`Final efficiency: ${(result.finalMatched.length / finalSessionInfos.length * 100).toFixed(1)}%`);

  // 9. Key insights
  log.normal('\n=== Key Insights ===');
  log.normal('The double-pass matcher:');
  log.normal('1. Identifies which sessions are not being used (excess)');
  log.normal('2. Allows reallocation of sessions between passes');
  log.normal('3. Maximizes URL-session matching efficiency');
  log.normal('4. Is a pure function with no side effects');

  // Cleanup
  await sessionManager.destroyAllSessions();
  log.normal('\n✅ Demo completed and cleaned up');
}

async function main() {
  try {
    await demonstrateDoublePassMatcher();
  } catch (error) {
    log.error('Demo failed:', error);
    process.exit(1);
  }
}

main();