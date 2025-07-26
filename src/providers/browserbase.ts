import type { Session, SessionOptions, BrowserbaseSession } from '../types/session.js';
import type { Proxy } from '../types/proxy.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('browserbase-provider');

/**
 * Create a Browserbase session with optional proxy configuration
 */
export async function createSession(options: SessionOptions = {}): Promise<Session> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;

  if (!apiKey) {
    throw new Error('BROWSERBASE_API_KEY environment variable is required');
  }

  if (!projectId) {
    throw new Error('BROWSERBASE_PROJECT_ID environment variable is required');
  }

  // Prepare session request
  const sessionRequest: any = {
    projectId,
    // Default timeout to 60 seconds
    timeout: options.timeout || 60,
    // Enable keepAlive by default for stability
    keepAlive: true
  };

  // Add proxy if provided
  if (options.proxy) {
    sessionRequest.proxies = [{
      type: 'external',
      server: options.proxy.url,
      username: options.proxy.username,
      password: options.proxy.password
    }];
  }

  // Create session via API with retry for 504 errors
  let response: Response;
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch('https://api.browserbase.com/v1/sessions', {
        method: 'POST',
        headers: {
          'X-BB-API-Key': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(sessionRequest)
      });

      if (response.ok) {
        break; // Success
      }
      
      const errorText = await response.text();
      lastError = new Error(`Failed to create Browserbase session: ${response.status} ${errorText}`);
      
      // Only retry on 504 Gateway Timeout
      if (response.status !== 504 || attempt === 2) {
        throw lastError;
      }
      
      log.debug(`Browserbase returned 504, retrying in ${2 ** attempt} seconds...`);
      await new Promise(resolve => setTimeout(resolve, 1000 * (2 ** attempt))); // 1s, 2s
      
    } catch (error) {
      // Network errors, also retry
      lastError = error as Error;
      if (attempt === 2) {
        throw error;
      }
      log.debug(`Network error creating session, retrying: ${lastError.message}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * (2 ** attempt)));
    }
  }
  
  if (!response! || !response.ok) {
    throw lastError || new Error('Failed to create Browserbase session');
  }

  const sessionData = await response.json();
  
  const browserbaseSession: BrowserbaseSession = {
    id: sessionData.id,
    connectUrl: sessionData.connectUrl,
    projectId,
    proxy: options.proxy
  };

  return {
    provider: 'browserbase',
    browserbase: browserbaseSession,
    cleanup: async () => {
      // Use the terminateSession function to properly release the session
      await terminateSession(browserbaseSession.id);
    }
  };
}

/**
 * List all sessions for the current project
 */
export async function listSessions(): Promise<BrowserbaseSession[]> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;

  if (!apiKey) {
    throw new Error('BROWSERBASE_API_KEY environment variable is required');
  }

  if (!projectId) {
    throw new Error('BROWSERBASE_PROJECT_ID environment variable is required');
  }

  const url = new URL('https://api.browserbase.com/v1/sessions');
  url.searchParams.set('projectId', projectId);
  url.searchParams.set('status', 'RUNNING');  // Only fetch RUNNING sessions

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-BB-API-Key': apiKey,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to list sessions: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const runningSessions = Array.isArray(data) ? data : (data.sessions || []);
  
  // No need to filter - API already returns only RUNNING sessions
  log.debug(`Found ${runningSessions.length} running sessions`);

  // Map to our BrowserbaseSession type
  return runningSessions.map((session: any) => ({
    id: session.id,
    connectUrl: session.connectUrl || '',
    projectId: session.projectId
  }));
}

/**
 * Terminate a specific session
 */
export async function terminateSession(sessionId: string): Promise<void> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;

  if (!apiKey) {
    throw new Error('BROWSERBASE_API_KEY environment variable is required');
  }

  if (!projectId) {
    throw new Error('BROWSERBASE_PROJECT_ID environment variable is required');
  }

  const response = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
    method: 'POST',
    headers: {
      'X-BB-API-Key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      projectId,
      status: 'REQUEST_RELEASE'
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to terminate session: ${response.status} ${errorText}`);
  }

  log.debug(`Session ${sessionId} termination requested`);
}