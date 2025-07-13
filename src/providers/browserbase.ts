import type { Session, SessionOptions, BrowserbaseSession } from '../types/session.js';
import type { Proxy } from '../types/proxy.js';

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
    projectId
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

  // Create session via API
  const response = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: {
      'X-BB-API-Key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(sessionRequest)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create Browserbase session: ${response.status} ${errorText}`);
  }

  const sessionData = await response.json();
  
  const browserbaseSession: BrowserbaseSession = {
    id: sessionData.id,
    connectUrl: sessionData.connectUrl,
    projectId
  };

  return {
    provider: 'browserbase',
    browserbase: browserbaseSession,
    cleanup: async () => {
      // Try to release the session
      try {
        await fetch(`https://api.browserbase.com/v1/sessions/${browserbaseSession.id}`, {
          method: 'DELETE',
          headers: {
            'X-BB-API-Key': apiKey,
            'Content-Type': 'application/json'
          }
        });
      } catch (error) {
        // Silently fail - session will timeout anyway
        console.error('Failed to release Browserbase session:', error);
      }
    }
  };
}