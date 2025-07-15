#!/usr/bin/env tsx --env-file=.env

/**
 * Architecture Demo
 * 
 * This example demonstrates the proper use of the layered architecture:
 * - Engines use services and core functions
 * - Services use drivers
 * - Drivers wrap providers
 * 
 * NEVER skip layers!
 */

import { logger } from '../src/utils/logger.js';

// Engine-level imports (top layer)
import { Engine } from '../src/engines/scrape-engine.js';

// Service-level imports
import { SessionManager } from '../src/services/session-manager.js';
import { SiteManager } from '../src/services/site-manager.js';
import { ScrapeRunManager } from '../src/services/scrape-run-manager.js';

// Core business logic (pure functions)
import { itemsToSessions, doublePassMatcher } from '../src/core/distributor.js';

// Driver imports (for demonstration only - normally engines don't use these)
import { createBrowserFromSession } from '../src/drivers/browser.js';

const log = logger.createContext('architecture-demo');

async function demonstrateLayering() {
  log.normal('=== Architecture Layering Demo ===\n');

  // 1. Engine Layer - Top-level orchestration
  log.normal('1. ENGINE LAYER');
  log.normal('   - Uses services and core functions');
  log.normal('   - Never uses drivers or providers directly\n');

  const engine = new Engine({
    provider: 'local',
    since: '1h',
    instanceLimit: 2
  });

  // 2. Service Layer - Stateful managers
  log.normal('2. SERVICE LAYER');
  log.normal('   - Uses drivers for external services');
  log.normal('   - Never uses providers directly');
  log.normal('   - Manages state and orchestration\n');

  const sessionManager = new SessionManager({ 
    sessionLimit: 3,
    provider: 'local'
  });

  const siteManager = new SiteManager();
  await siteManager.loadSites();

  // 3. Core Layer - Pure business logic
  log.normal('3. CORE LAYER');
  log.normal('   - Pure functions only');
  log.normal('   - No side effects or external calls');
  log.normal('   - Can be tested in isolation\n');

  // Example of pure function usage
  const mockItems = [
    { url: 'https://example.com/1', done: false, failed: false },
    { url: 'https://example.com/2', done: false, failed: false }
  ];

  const mockSessions = [
    { id: 'session-1', proxyType: 'datacenter' as const, proxyGeo: 'US' },
    { id: 'session-2', proxyType: 'datacenter' as const, proxyGeo: 'US' }
  ];

  const matched = itemsToSessions(mockItems, mockSessions, []);
  log.normal(`   itemsToSessions matched ${matched.length} pairs`);

  // 4. Demonstrating double-pass matcher
  log.normal('\n4. DOUBLE-PASS MATCHER');
  log.normal('   - Pure function in core/distributor.ts');
  log.normal('   - Takes initial and final session lists');
  log.normal('   - Returns first pass, excess sessions, and final results\n');

  const newSessions = [...mockSessions, { id: 'session-3', proxyType: 'datacenter' as const, proxyGeo: 'US' }];
  const { firstPassMatched, excessSessions, finalMatched } = doublePassMatcher(
    mockItems,
    mockSessions,
    newSessions,
    []
  );

  log.normal(`   First pass: ${firstPassMatched.length} matched`);
  log.normal(`   Excess sessions: ${excessSessions.length}`);
  log.normal(`   Final matched: ${finalMatched.length}`);

  // 5. What NOT to do
  log.normal('\n5. ARCHITECTURE VIOLATIONS TO AVOID:');
  log.normal('   ❌ Engine importing from drivers/');
  log.normal('   ❌ Service importing from providers/');
  log.normal('   ❌ Core importing from services/');
  log.normal('   ❌ Skipping layers in the hierarchy');

  // 6. Proper session and browser flow
  log.normal('\n6. PROPER SESSION → BROWSER FLOW:');
  
  // Create a session through the service layer
  const session = await sessionManager.createSession();
  log.normal('   ✅ Created session via SessionManager (service)');
  
  // Get the actual Session object
  const sessions = await sessionManager.getActiveSessions();
  log.normal(`   ✅ SessionManager returns ${sessions.length} Session objects`);
  
  if (sessions.length > 0) {
    // Create browser from session using driver
    const { browser, createContext, cleanup } = await createBrowserFromSession(sessions[0]);
    log.normal('   ✅ Created browser via browser.ts driver');
    
    // Clean up
    await cleanup();
    log.normal('   ✅ Cleaned up browser and session');
  }

  // Clean up all sessions
  await sessionManager.destroyAllSessions();
}

async function main() {
  try {
    await demonstrateLayering();
    log.normal('\n✅ Architecture demo completed successfully');
  } catch (error) {
    log.error('Demo failed:', error);
    process.exit(1);
  }
}

main();