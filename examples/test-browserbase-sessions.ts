#!/usr/bin/env tsx --env-file=.env

/**
 * Test script to verify browserbase session status checking
 * This tests the ability to list sessions and identify which are actually running
 */

import { createSession, listSessions, terminateSession } from '../src/providers/browserbase.js';
import { logger } from '../src/utils/logger.js';

const log = logger.createContext('test-browserbase-sessions');

async function testRawAPI() {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;

  if (!apiKey || !projectId) {
    throw new Error('Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID');
  }

  // Test without status filter
  log.normal('Testing API without status filter...');
  const urlAll = new URL('https://api.browserbase.com/v1/sessions');
  urlAll.searchParams.set('projectId', projectId);

  const responseAll = await fetch(urlAll.toString(), {
    method: 'GET',
    headers: {
      'X-BB-API-Key': apiKey,
      'Content-Type': 'application/json'
    }
  });

  const dataAll = await responseAll.json();
  log.normal(`Total sessions without filter: ${dataAll.length}`);
  
  // Count by status
  const statusCounts: Record<string, number> = {};
  dataAll.forEach((session: any) => {
    statusCounts[session.status] = (statusCounts[session.status] || 0) + 1;
  });
  log.normal('Sessions by status:', statusCounts);

  // Test with status=RUNNING filter
  log.normal('\nTesting API with status=RUNNING filter...');
  const urlRunning = new URL('https://api.browserbase.com/v1/sessions');
  urlRunning.searchParams.set('projectId', projectId);
  urlRunning.searchParams.set('status', 'RUNNING');

  const responseRunning = await fetch(urlRunning.toString(), {
    method: 'GET',
    headers: {
      'X-BB-API-Key': apiKey,
      'Content-Type': 'application/json'
    }
  });

  const dataRunning = await responseRunning.json();
  log.normal(`Sessions with status=RUNNING filter: ${dataRunning.length}`);
  
  if (dataRunning.length > 0) {
    log.normal('Sample RUNNING session:');
    console.log(JSON.stringify(dataRunning[0], null, 2));
  }
}

async function main() {
  try {
    // First, let's see the raw API response
    log.normal('Testing raw browserbase API...');
    await testRawAPI();
    
    // Show only running sessions
    log.normal('\nFiltering for RUNNING sessions only...');
    const apiKey = process.env.BROWSERBASE_API_KEY!;
    const projectId = process.env.BROWSERBASE_PROJECT_ID!;
    const url = new URL('https://api.browserbase.com/v1/sessions');
    url.searchParams.set('projectId', projectId);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-BB-API-Key': apiKey,
        'Content-Type': 'application/json'
      }
    });
    const allData = await response.json();
    const runningSessions = allData.filter((s: any) => s.status === 'RUNNING');
    log.normal(`Found ${runningSessions.length} RUNNING sessions out of ${allData.length} total`);

    // Step 1: Create a test session
    log.normal('\nCreating test session...');
    const session = await createSession({ timeout: 300 });
    const sessionId = session.browserbase!.id;
    log.normal(`Created session: ${sessionId}`);

    // Step 2: List all sessions and show their status
    log.normal('\nListing all sessions...');
    const allSessions = await listSessions();
    
    // Get raw response to see actual data
    log.normal(`\nRaw browserbase response (${allSessions.length} sessions):`);
    console.log(JSON.stringify(allSessions, null, 2));

    // Step 3: Find our session
    const ourSession = allSessions.find(s => s.id === sessionId);
    if (ourSession) {
      log.normal(`\nOur session found in list: ${sessionId}`);
    } else {
      log.error(`Our session NOT found in list: ${sessionId}`);
    }

    // Step 4: Terminate the session
    log.normal('\nTerminating session...');
    await terminateSession(sessionId);

    // Step 5: List sessions again to see if it's gone
    log.normal('\nListing sessions after termination...');
    const sessionsAfter = await listSessions();
    const stillExists = sessionsAfter.find(s => s.id === sessionId);
    
    if (stillExists) {
      log.error(`Session still exists after termination: ${sessionId}`);
    } else {
      log.normal(`Session successfully removed from active list: ${sessionId}`);
    }

    log.normal(`\nActive sessions after cleanup: ${sessionsAfter.length}`);

  } catch (error) {
    log.error('Test failed:', error);
    process.exit(1);
  }
}

main();