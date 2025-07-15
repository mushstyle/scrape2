#!/usr/bin/env node --env-file=.env

/**
 * Example demonstrating the new session-based architecture
 * Shows how to use both Browserbase and local browser providers
 * using the SessionManager service
 */

import { SessionManager } from '../src/services/session-manager.js';
import { createBrowserFromSession } from '../src/drivers/browser.js';

async function testProvider(providerName, sessionManager) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing ${providerName}`);
  console.log(`${'='.repeat(60)}\n`);

  // Create session using SessionManager
  console.log(`Creating ${providerName} session...`);
  const sessionId = await sessionManager.createSession();
  const sessions = await sessionManager.getActiveSessions();
  const session = sessions.find(s => s.id === sessionId);
  
  try {
    // Create browser from session
    const { browser, createContext, cleanup } = await createBrowserFromSession(session, {
      blockImages: true
    });

    console.log('✅ Browser connected successfully');

    // Create context (proxy is automatically applied for local browser)
    const context = await createContext();
    const page = await context.newPage();

    // Test navigation
    console.log('Testing navigation...');
    await page.goto('https://httpbin.org/ip');
    const ipInfo = await page.textContent('body');
    console.log('IP Info:', ipInfo);

    // Test headers to verify proxy
    await page.goto('https://httpbin.org/headers');
    const headers = await page.textContent('body');
    const headersJson = JSON.parse(headers);
    console.log('User-Agent:', headersJson.headers['User-Agent']);
    
    // Clean up
    await page.close();
    await context.close();
    await cleanup();
    
    console.log('✅ Session cleaned up successfully');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    await sessionManager.destroySession(sessionId);
  }
}

async function main() {
  try {
    // Test local browser
    const localSessionManager = new SessionManager({
      sessionLimit: 1,
      provider: 'local'
    });
    await testProvider('Local Browser', localSessionManager);
    await localSessionManager.destroyAllSessions();

    // Test Browserbase (only if credentials are available)
    if (process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID) {
      const browserbaseSessionManager = new SessionManager({
        sessionLimit: 1,
        provider: 'browserbase'
      });
      await testProvider('Browserbase', browserbaseSessionManager);
      await browserbaseSessionManager.destroyAllSessions();
    } else {
      console.log('\n⚠️  Skipping Browserbase test (missing API credentials)');
    }
    
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();