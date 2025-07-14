#!/usr/bin/env node

import { logger } from '../src/lib/logger.js';
import { SessionManager } from '../src/lib/session-manager.js';
import { ScrapeRunManager } from '../src/lib/scrape-run-manager.js';
import { itemsToSessions, type SessionInfo } from '../src/lib/distributor.js';
import { getSiteConfig } from '../src/types/site-config.js';

const log = logger.createContext('orchestration-demo');

/**
 * Demonstrates the complete orchestration workflow
 */
async function main() {
  // Check required environment variables
  if (!process.env.ETL_API_ENDPOINT || !process.env.ETL_API_KEY) {
    log.error('Missing required environment variables: ETL_API_ENDPOINT and ETL_API_KEY');
    process.exit(1);
  }
  
  const domain = process.argv[2];
  if (!domain) {
    console.log('Usage: npm run orchestration-demo <domain>');
    console.log('Example: npm run orchestration-demo amgbrand.com');
    process.exit(1);
  }
  
  try {
    // Initialize managers
    const sessionManager = new SessionManager({
      sessionLimit: 3,
      provider: 'browserbase'
    });
    
    const runManager = new ScrapeRunManager();
    
    // Step 1: Get or create a scrape run
    log.normal('Step 1: Getting or creating scrape run...');
    const run = await runManager.getOrCreateRun(domain);
    log.normal(`Using run ${run.id} with ${run.items.length} items`);
    
    // Step 2: Get pending items
    log.normal('\\nStep 2: Getting pending items...');
    const pendingItems = await runManager.getPendingItems(run.id);
    log.normal(`Found ${pendingItems.length} pending items`);
    
    if (pendingItems.length === 0) {
      log.normal('No pending items to process');
      return;
    }
    
    // Step 3: Create sessions
    log.normal('\\nStep 3: Creating sessions...');
    const sessionCount = Math.min(3, pendingItems.length);
    const sessionIds: string[] = [];
    
    for (let i = 0; i < sessionCount; i++) {
      const sessionId = await sessionManager.createSession({ domain });
      sessionIds.push(sessionId);
    }
    log.normal(`Created ${sessionIds.length} sessions`);
    
    // Step 4: Get site config for proxy requirements
    log.normal('\\nStep 4: Getting site configuration...');
    let siteConfig;
    try {
      siteConfig = await getSiteConfig(domain);
      log.normal(`Site proxy strategy: ${siteConfig.proxy?.strategy || 'none'}`);
    } catch (error) {
      log.normal('Could not fetch site config, proceeding without proxy requirements');
    }
    
    // Step 5: Distribute items to sessions
    log.normal('\\nStep 5: Distributing items to sessions...');
    
    // Convert session IDs to SessionInfo objects
    // In a real implementation, the session manager would track proxy info
    const sessionInfos: SessionInfo[] = sessionIds.map((id, index) => ({
      id,
      // For demo purposes, assign different proxy types
      proxyType: index === 0 ? 'datacenter' : index === 1 ? 'residential' : 'none',
      proxyId: index === 0 ? 'proxy-dc-1' : index === 1 ? 'proxy-res-1' : undefined
    }));
    
    const urlSessionPairs = itemsToSessions(pendingItems, sessionInfos, siteConfig);
    
    log.normal(`Distributed ${urlSessionPairs.length} items to sessions`);
    
    // Show distribution summary
    const sessionCounts = new Map<string, number>();
    urlSessionPairs.forEach(pair => {
      sessionCounts.set(pair.sessionId, (sessionCounts.get(pair.sessionId) || 0) + 1);
    });
    
    sessionCounts.forEach((count, sessionId) => {
      log.normal(`Session ${sessionId}: ${count} items`);
    });
    
    // Step 6: Simulate processing
    log.normal('\\nStep 6: Simulating item processing...');
    
    // Simulate processing some items
    const itemsToProcess = Math.min(5, pendingItems.length);
    for (let i = 0; i < itemsToProcess; i++) {
      const item = pendingItems[i];
      
      // Simulate success/failure
      const isSuccess = Math.random() > 0.2; // 80% success rate
      
      await runManager.updateItemStatus(run.id, item.url, {
        done: isSuccess,
        failed: !isSuccess
      });
      
      log.normal(`Processed ${item.url}: ${isSuccess ? 'success' : 'failed'}`);
    }
    
    // Step 7: Get run statistics
    log.normal('\\nStep 7: Getting run statistics...');
    const stats = await runManager.getRunStats(run.id);
    log.normal('Run statistics:', stats);
    
    // Step 8: Clean up sessions
    log.normal('\\nStep 8: Cleaning up sessions...');
    for (const sessionId of sessionIds) {
      await sessionManager.destroySession(sessionId);
    }
    log.normal('Sessions cleaned up');
    
    // Optional: Finalize run if all items are processed
    if (stats.pending === 0) {
      log.normal('\\nAll items processed, finalizing run...');
      await runManager.finalizeRun(run.id);
      log.normal('Run finalized');
    }
    
  } catch (error) {
    log.error('Error in orchestration demo', { error });
    process.exit(1);
  }
}

// Handle errors
process.on('unhandledRejection', (error) => {
  log.error('Unhandled rejection', { error });
  process.exit(1);
});

// Run the demo
main();