#!/usr/bin/env node

import { logger } from '../src/lib/logger.js';
import { parseArgs } from 'node:util';

const log = logger.createContext('browserbase-sessions');

const API_KEY = process.env.BROWSERBASE_API_KEY;
const PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

if (!API_KEY || !PROJECT_ID) {
  log.error('Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID in .env');
  process.exit(1);
}

async function createSession() {
  log.normal('Creating new Browserbase session...');
  
  const response = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: {
      'X-BB-API-Key': API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      projectId: PROJECT_ID
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create session: ${response.status} ${errorText}`);
  }

  const session = await response.json();
  log.normal(`Created session: ${session.id}`);
  log.normal(`Connect URL: ${session.connectUrl}`);
  return session;
}

async function listSessions() {
  log.normal('Fetching active sessions...');
  
  const response = await fetch(`https://api.browserbase.com/v1/sessions?projectId=${PROJECT_ID}`, {
    method: 'GET',
    headers: {
      'X-BB-API-Key': API_KEY,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to list sessions: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const sessions = data.sessions || [];
  
  if (sessions.length === 0) {
    log.normal('No active sessions found');
  } else {
    log.normal(`Found ${sessions.length} active session(s):`);
    sessions.forEach((session: any, index: number) => {
      log.normal(`  ${index + 1}. ID: ${session.id}`);
      log.normal(`     Status: ${session.status}`);
      log.normal(`     Created: ${new Date(session.createdAt).toLocaleString()}`);
      if (session.expiresAt) {
        log.normal(`     Expires: ${new Date(session.expiresAt).toLocaleString()}`);
      }
    });
  }
  
  return sessions;
}

async function killSession(sessionId: string) {
  log.normal(`Killing session: ${sessionId}`);
  
  const response = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: {
      'X-BB-API-Key': API_KEY,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to kill session: ${response.status} ${errorText}`);
  }

  log.normal(`Session ${sessionId} killed successfully`);
}

async function killAllSessions() {
  const sessions = await listSessions();
  
  if (sessions.length === 0) {
    log.normal('No sessions to kill');
    return;
  }

  log.normal(`Killing ${sessions.length} session(s)...`);
  
  for (const session of sessions) {
    try {
      await killSession(session.id);
    } catch (error) {
      log.error(`Failed to kill session ${session.id}:`, error);
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      action: {
        type: 'string',
        short: 'a'
      },
      'session-id': {
        type: 'string',
        short: 's'
      }
    }
  });

  const action = values.action || 'list';

  try {
    switch (action) {
      case 'create':
        await createSession();
        break;
        
      case 'list':
        await listSessions();
        break;
        
      case 'kill':
        if (!values['session-id']) {
          log.error('--session-id required for kill action');
          process.exit(1);
        }
        await killSession(values['session-id']);
        break;
        
      case 'kill-all':
        await killAllSessions();
        break;
        
      default:
        console.log('Usage: npm run example:browserbase-sessions -- --action=[create|list|kill|kill-all]');
        console.log('Options:');
        console.log('  --action, -a     Action to perform (default: list)');
        console.log('  --session-id, -s Session ID for kill action');
        console.log('\nExamples:');
        console.log('  npm run example:browserbase-sessions');
        console.log('  npm run example:browserbase-sessions -- --action=create');
        console.log('  npm run example:browserbase-sessions -- --action=kill --session-id=abc123');
        console.log('  npm run example:browserbase-sessions -- --action=kill-all');
        process.exit(1);
    }
  } catch (error) {
    log.error('Operation failed:', error);
    process.exit(1);
  }
}

main();