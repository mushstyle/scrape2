#!/usr/bin/env node

import { logger } from '../src/lib/logger.js';
import { parseArgs } from 'node:util';
import * as browserbase from '../src/providers/browserbase.js';

const log = logger.createContext('browserbase-sessions');

async function createSession(options: { proxy?: boolean; keepAlive?: boolean; timeout?: number } = {}) {
  log.normal('Creating new Browserbase session...');
  
  try {
    const session = await browserbase.createSession({
      timeout: options.timeout
      // Note: proxy would come from db/proxies.json in real usage
    });
    
    log.normal(`Created session: ${session.browserbase!.id}`);
    log.normal(`Connect URL: ${session.browserbase!.connectUrl}`);
    
    // Clean up the session since this is just a demo
    await session.cleanup();
    log.normal('Session cleanup completed');
  } catch (error) {
    log.error('Failed to create session:', error);
    throw error;
  }
}

async function listSessions() {
  log.normal('Fetching active sessions...');
  
  try {
    const sessions = await browserbase.listSessions();
    
    if (sessions.length === 0) {
      log.normal('No active sessions found');
    } else {
      log.normal(`Found ${sessions.length} active session(s):`);
      sessions.forEach((session, index) => {
        log.normal(`  ${index + 1}. ${session.id} | Project: ${session.projectId}`);
      });
    }
    
    return sessions;
  } catch (error) {
    log.error('Failed to list sessions:', error);
    throw error;
  }
}

async function terminateSession(sessionId: string) {
  log.normal(`Terminating session: ${sessionId}`);
  
  try {
    await browserbase.terminateSession(sessionId);
    log.normal(`Session ${sessionId} termination requested`);
  } catch (error) {
    log.error(`Failed to terminate session ${sessionId}:`, error);
    throw error;
  }
}

async function terminateAllSessions() {
  try {
    const sessions = await browserbase.listSessions();
    
    if (sessions.length === 0) {
      log.normal('No active sessions to terminate');
      return;
    }

    log.normal(`Terminating ${sessions.length} active session(s)...`);
    
    // Terminate all sessions in parallel
    const results = await Promise.allSettled(
      sessions.map(session => browserbase.terminateSession(session.id))
    );
    
    // Report any failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        log.error(`Failed to terminate session ${sessions[index].id}:`, result.reason);
      }
    });
  } catch (error) {
    log.error('Failed to terminate sessions:', error);
    throw error;
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
      },
      timeout: {
        type: 'string',
        short: 't'
      },
      verbose: {
        type: 'boolean',
        short: 'v'
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
        const timeout = values.timeout ? parseInt(values.timeout) : undefined;
        await createSession({ timeout });
        break;
        
      case 'list':
        await listSessions();
        break;
        
      case 'terminate':
        if (!values['session-id']) {
          log.error('--session-id required for terminate action');
          process.exit(1);
        }
        await terminateSession(values['session-id']);
        break;
        
      case 'terminate-all':
        await terminateAllSessions();
        break;
        
      default:
        console.log('Usage: npm run example:browserbase-sessions -- --action=[create|list|terminate|terminate-all]');
        console.log('\nOptions:');
        console.log('  --action, -a      Action to perform (default: list)');
        console.log('  --session-id, -s  Session ID for terminate action');
        console.log('  --timeout, -t     Session timeout in seconds (default: 60)');
        console.log('  --verbose, -v     Enable debug logging');
        console.log('\nExamples:');
        console.log('  npm run example:browserbase-sessions');
        console.log('  npm run example:browserbase-sessions -- --action=create');
        console.log('  npm run example:browserbase-sessions -- --action=create --timeout=300');
        console.log('  npm run example:browserbase-sessions -- --action=list --verbose');
        console.log('  npm run example:browserbase-sessions -- --action=terminate --session-id=abc123');
        console.log('  npm run example:browserbase-sessions -- --action=terminate-all');
        process.exit(1);
    }
  } catch (error) {
    log.error('Operation failed:', error);
    process.exit(1);
  }
}

main();