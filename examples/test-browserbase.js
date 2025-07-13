#!/usr/bin/env node --env-file=.env

import { createBrowser } from '../src/lib/browser.ts';

async function test() {
  if (!process.env.BROWSERBASE_API_KEY) {
    console.log('❌ BROWSERBASE_API_KEY not found in environment');
    console.log('Please add it to your .env file');
    return;
  }

  console.log('Testing Browserbase connection with Node.js...');
  
  try {
    // You'll need to create a session first using Browserbase API
    // For testing, you can use their API to create a session
    console.log('Note: You need a valid Browserbase session ID');
    console.log('You can create one using:');
    console.log('curl -X POST https://api.browserbase.com/v1/sessions \\');
    console.log('  -H "X-API-Key: YOUR_API_KEY" \\');
    console.log('  -H "Content-Type: application/json"');
    
    // Uncomment and add a real session ID to test
    // const { browser, cleanup } = await createBrowser({
    //   provider: 'browserbase',
    //   sessionId: 'YOUR_SESSION_ID_HERE'
    // });
    
    // const context = await browser.newContext();
    // const page = await context.newPage();
    // await page.goto('https://httpbin.org/ip');
    // console.log('✅ Successfully connected to Browserbase!');
    // console.log('Response:', await page.textContent('body'));
    // await cleanup();
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.message.includes('WebSocket') || error.message.includes('timeout')) {
      console.log('\n⚠️  WebSocket connection error');
    }
  }
}

test();