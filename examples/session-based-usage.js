#!/usr/bin/env node --env-file=.env

/**
 * Example demonstrating the new session-based architecture
 * Shows how to use both Browserbase and local browser providers
 */

// NOTE: This example shows proper architecture usage
// We use drivers, not providers directly
import { createBrowserbaseSession, createLocalSession, createBrowserFromSession } from '../src/drivers/browser.js';
import { loadProxies, getDefaultProxy } from '../src/drivers/proxy.js';

async function testProvider(providerName, createSessionFn) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing ${providerName}`);
  console.log(`${'='.repeat(60)}\n`);

  // Load proxy configuration
  const proxyStore = await loadProxies();
  const proxy = getDefaultProxy(proxyStore);
  
  if (proxy) {
    console.log(`📡 Using proxy: ${proxy.id} (${proxy.provider})`);
  }

  // Create session with proxy
  console.log(`Creating ${providerName} session...`);
  const session = await createSessionFn({ proxy });
  
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
    await session.cleanup();
  }
}

async function main() {
  try {
    // Test local browser
    await testProvider('Local Browser', createLocalSession);

    // Test Browserbase (only if credentials are available)
    if (process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID) {
      await testProvider('Browserbase', createBrowserbaseSession);
    } else {
      console.log('\n⚠️  Skipping Browserbase test (missing API credentials)');
    }
    
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();