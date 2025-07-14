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

async function createSession(options: { proxy?: boolean; keepAlive?: boolean; timeout?: number } = {}) {
  log.normal('Creating new Browserbase session...');
  
  const sessionConfig: any = {
    projectId: PROJECT_ID,
    // Default to 60 seconds timeout and keepAlive true
    timeout: options.timeout || 60000, // 60 seconds in milliseconds
    keepAlive: options.keepAlive !== undefined ? options.keepAlive : true
  };

  log.normal(`Session config: timeout=${sessionConfig.timeout}ms, keepAlive=${sessionConfig.keepAlive}`);

  // Add proxy if requested
  if (options.proxy) {
    log.normal('Adding proxy configuration...');
    // This would use a proxy from your db/proxies.json in real usage
    sessionConfig.proxies = [{
      type: 'external',
      server: 'http://example-proxy.com:8080',
      username: 'user',
      password: 'pass'
    }];
  }
  
  const response = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: {
      'X-BB-API-Key': API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(sessionConfig)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create session: ${response.status} ${errorText}`);
  }

  const session = await response.json();
  log.normal(`Created session: ${session.id}`);
  log.normal(`Connect URL: ${session.connectUrl}`);
  log.normal(`Status: ${session.status || 'active'}`);
  if (session.expiresAt) {
    log.normal(`Expires: ${new Date(session.expiresAt).toLocaleString()}`);
  }
  return session;
}

async function listSessions() {
  log.normal('Fetching active sessions...');
  
  // Include projectId as query parameter
  const url = new URL('https://api.browserbase.com/v1/sessions');
  url.searchParams.set('projectId', PROJECT_ID);
  
  const response = await fetch(url.toString(), {
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
  log.debug('API response:', JSON.stringify(data, null, 2));
  
  // Handle different possible response formats
  const allSessions = Array.isArray(data) ? data : (data.sessions || []);
  
  // Filter for only active sessions
  const activeSessions = allSessions.filter((session: any) => {
    // Check if session is active based on status or expiry time
    const statusLower = session.status?.toLowerCase();
    const isActiveStatus = !session.status || statusLower === 'active' || statusLower === 'running';
    const notExpired = !session.expiresAt || new Date(session.expiresAt) > new Date();
    return isActiveStatus && notExpired;
  });
  
  if (activeSessions.length === 0) {
    log.normal('No active sessions found');
    if (allSessions.length > 0) {
      log.normal(`(${allSessions.length} inactive/expired session(s) filtered out)`);
    }
  } else {
    log.normal(`Found ${activeSessions.length} active session(s):`);
    activeSessions.forEach((session: any, index: number) => {
      const created = session.createdAt ? new Date(session.createdAt).toLocaleTimeString() : 'unknown';
      const expires = session.expiresAt ? new Date(session.expiresAt).toLocaleTimeString() : 'never';
      const status = session.status || 'active';
      log.normal(`  ${index + 1}. ${session.id} | ${status} | Created: ${created} | Expires: ${expires}`);
    });
  }
  
  return activeSessions;
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
  const activeSessions = await listSessions();
  
  if (activeSessions.length === 0) {
    log.normal('No active sessions to kill');
    return;
  }

  log.normal(`Killing ${activeSessions.length} active session(s)...`);
  
  for (const session of activeSessions) {
    try {
      await killSession(session.id);
    } catch (error) {
      log.error(`Failed to kill session ${session.id}:`, error);
    }
  }
}

async function getSession(sessionId: string) {
  log.normal(`Fetching session: ${sessionId}`);
  
  const response = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
    method: 'GET',
    headers: {
      'X-BB-API-Key': API_KEY,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get session: ${response.status} ${errorText}`);
  }

  const session = await response.json();
  log.normal('Session details:');
  log.normal(JSON.stringify(session, null, 2));
  return session;
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
      },
      proxy: {
        type: 'boolean',
        short: 'p'
      },
      'keep-alive': {
        type: 'boolean',
        short: 'k'
      },
      verbose: {
        type: 'boolean',
        short: 'v'
      },
      timeout: {
        type: 'string',
        short: 't'
      }
    }
  });

  const action = values.action || 'list';

  // Enable debug logging if verbose
  if (values.verbose) {
    logger.setLevel('debug');
  }

  try {
    switch (action) {
      case 'create':
        const timeout = values.timeout ? parseInt(values.timeout) * 1000 : undefined;
        await createSession({
          proxy: values.proxy,
          keepAlive: values['keep-alive'],
          timeout
        });
        break;
        
      case 'list':
        await listSessions();
        break;
        
      case 'get':
        if (!values['session-id']) {
          log.error('--session-id required for get action');
          process.exit(1);
        }
        await getSession(values['session-id']);
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
        console.log('Usage: npm run example:browserbase-sessions -- --action=[create|list|get|kill|kill-all]');
        console.log('\nOptions:');
        console.log('  --action, -a      Action to perform (default: list)');
        console.log('  --session-id, -s  Session ID for get/kill actions');
        console.log('  --proxy, -p       Add proxy to session (create only)');
        console.log('  --keep-alive, -k  Keep session alive (default: true)');
        console.log('  --timeout, -t     Session timeout in seconds (default: 60)');
        console.log('  --verbose, -v     Enable debug logging');
        console.log('\nExamples:');
        console.log('  npm run example:browserbase-sessions');
        console.log('  npm run example:browserbase-sessions -- --action=create');
        console.log('  npm run example:browserbase-sessions -- --action=create --timeout=300');
        console.log('  npm run example:browserbase-sessions -- --action=create --proxy --no-keep-alive');
        console.log('  npm run example:browserbase-sessions -- --action=list --verbose');
        console.log('  npm run example:browserbase-sessions -- --action=get --session-id=abc123');
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