#!/usr/bin/env node --env-file=.env

import { createBrowser } from '../src/lib/browser.ts';
import { loadProxies, getDefaultProxy } from '../src/lib/proxy.ts';

async function test() {
  if (!process.env.BROWSERBASE_API_KEY) {
    console.log('❌ BROWSERBASE_API_KEY not found in environment');
    console.log('Please add it to your .env file');
    return;
  }

  if (!process.env.BROWSERBASE_PROJECT_ID) {
    console.log('❌ BROWSERBASE_PROJECT_ID not found in environment');
    console.log('Please add it to your .env file');
    return;
  }

  console.log('Testing Browserbase connection with Node.js...');
  
  let sessionId;
  
  try {
    // Load proxy configuration using the proxy primitives
    const proxyStore = await loadProxies();
    const defaultProxy = getDefaultProxy(proxyStore);
    
    // Prepare session create request
    const sessionRequest = {
      projectId: process.env.BROWSERBASE_PROJECT_ID
    };
    
    // Add proxy if available
    if (defaultProxy) {
      console.log(`📡 Using proxy: ${defaultProxy.id} (${defaultProxy.provider})`);
      sessionRequest.proxies = [{
        type: 'external',
        server: defaultProxy.url,
        username: defaultProxy.username,
        password: defaultProxy.password
      }];
    }
    
    // Create session using fetch API
    console.log('Creating Browserbase session...');
    const response = await fetch('https://api.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: {
        'X-BB-API-Key': process.env.BROWSERBASE_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(sessionRequest)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create session: ${response.status} ${errorText}`);
    }
    
    const session = await response.json();
    sessionId = session.id;
    
    console.log(`🌐 Browserbase session created: ${sessionId}`);
    
    // Create browser using the connectUrl from session response
    const { browser, cleanup } = await createBrowser({
      provider: 'browserbase',
      connectUrl: session.connectUrl
    });
    
    // Test the browser connection
    const context = await browser.newContext();
    const page = await context.newPage();
    
    console.log('Navigating to test page...');
    await page.goto('https://httpbin.org/ip');
    
    console.log('✅ Successfully connected to Browserbase!');
    const responseText = await page.textContent('body');
    console.log('Response:', responseText);
    
    // Also test another page to verify proxy
    console.log('\nTesting proxy IP detection...');
    await page.goto('https://api.ipify.org?format=json');
    const ipResponse = await page.textContent('body');
    console.log('IP Response:', ipResponse);
    
    // Clean up
    await cleanup();
    
    // Release the session
    if (sessionId) {
      console.log('\nReleasing Browserbase session...');
      const releaseResponse = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: {
          'X-BB-API-Key': process.env.BROWSERBASE_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          projectId: process.env.BROWSERBASE_PROJECT_ID,
          status: 'REQUEST_RELEASE'
        })
      });
      
      if (releaseResponse.ok) {
        console.log('🧹 Released Browserbase session');
      } else {
        console.error('Failed to release session:', await releaseResponse.text());
      }
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.message.includes('WebSocket') || error.message.includes('timeout')) {
      console.log('\n⚠️  WebSocket connection error');
    }
    
    // Try to clean up session on error
    if (sessionId) {
      try {
        await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
          method: 'PATCH',
          headers: {
            'X-API-Key': process.env.BROWSERBASE_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            projectId: process.env.BROWSERBASE_PROJECT_ID,
            status: 'REQUEST_RELEASE'
          })
        });
        console.log('🧹 Released Browserbase session (after error)');
      } catch (releaseError) {
        console.error('Failed to release session:', releaseError.message);
      }
    }
  }
}

test();