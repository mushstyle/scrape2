#!/usr/bin/env tsx --env-file=.env

/**
 * Proper Layering Example
 * 
 * This example shows the CORRECT way to use the layered architecture.
 * It demonstrates what each layer should and shouldn't do.
 */

import { logger } from '../src/utils/logger.js';

// ✅ CORRECT: Engine imports
import { SessionManager } from '../src/services/session-manager.js';
import { SiteManager } from '../src/services/site-manager.js';
import { itemsToSessions, doublePassMatcher } from '../src/core/distributor.js';

// ❌ WRONG: These imports would violate the architecture
// import { createBrowserbaseSession } from '../src/providers/browserbase.js';  // NO!
// import { createBrowserFromSession } from '../src/drivers/browser.js';        // NO!

const log = logger.createContext('proper-layering');

async function demonstrateProperLayering() {
  log.normal('=== Proper Architecture Layering ===\n');

  // 1. Services manage state and use drivers
  log.normal('1. SERVICES LAYER (Correct Usage)');
  
  const sessionManager = new SessionManager({ 
    sessionLimit: 3,
    provider: 'local' 
  });

  // The SessionManager internally uses the browser driver
  // to create sessions, but we don't see that here
  const session = await sessionManager.createSession();
  log.normal('   ✅ Created session through SessionManager');
  
  // SessionManager returns actual Session objects
  const sessions = await sessionManager.getActiveSessions();
  log.normal(`   ✅ Got ${sessions.length} Session objects (not just IDs!)`);

  // 2. Core functions are pure - no side effects
  log.normal('\n2. CORE LAYER (Pure Functions)');
  
  const mockItems = [
    { url: 'https://example.com/1', done: false, failed: false },
    { url: 'https://example.com/2', done: false, failed: false },
    { url: 'https://example.com/3', done: false, failed: false }
  ];

  const mockSessionInfos = [
    { id: 'session-1', proxyType: 'datacenter' as const },
    { id: 'session-2', proxyType: 'datacenter' as const }
  ];

  // Pure function - no external calls
  const matched = itemsToSessions(mockItems, mockSessionInfos, []);
  log.normal(`   ✅ itemsToSessions matched ${matched.length} pairs (pure function)`);

  // Another pure function
  const result = doublePassMatcher(
    mockItems,
    mockSessionInfos,
    [...mockSessionInfos, { id: 'session-3', proxyType: 'datacenter' as const }],
    []
  );
  log.normal(`   ✅ doublePassMatcher returned ${result.finalMatched.length} final matches`);

  // 3. What NOT to do
  log.normal('\n3. ARCHITECTURE VIOLATIONS TO AVOID:');
  log.normal('   ❌ DON\'T import providers in engines or services');
  log.normal('   ❌ DON\'T import drivers in engines');
  log.normal('   ❌ DON\'T skip layers (e.g., engine → provider)');
  log.normal('   ❌ DON\'T put side effects in core functions');
  log.normal('   ❌ DON\'T store just IDs when you need objects');

  // 4. The correct flow
  log.normal('\n4. THE CORRECT FLOW:');
  log.normal('   Provider creates Session → Driver wraps it → Service manages it → Engine uses it');
  log.normal('   Each layer only knows about the layer directly below it');

  // Clean up
  await sessionManager.destroyAllSessions();
  log.normal('\n✅ Cleaned up all resources');
}

async function main() {
  try {
    await demonstrateProperLayering();
    log.normal('\n✅ Proper layering demo completed');
  } catch (error) {
    log.error('Demo failed:', error);
    process.exit(1);
  }
}

main();