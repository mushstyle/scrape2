import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSession } from '../src/providers/browserbase.js';
import type { Proxy } from '../src/types/proxy.js';

// Mock fetch globally
global.fetch = vi.fn();

describe('Browserbase Proxy Persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set required environment variables
    process.env.BROWSERBASE_API_KEY = 'test-api-key';
    process.env.BROWSERBASE_PROJECT_ID = 'test-project-id';
  });

  it('should persist proxy information in browserbase session', async () => {
    const mockProxy: Proxy = {
      type: 'datacenter',
      id: 'oxylabs-us-datacenter-8',
      geo: 'US',
      url: 'http://proxy.example.com:8080',
      username: 'testuser',
      password: 'testpass'
    };

    // Mock successful session creation response
    const mockResponse = {
      ok: true,
      json: async () => ({
        id: 'test-session-id',
        connectUrl: 'wss://connect.browserbase.com/test-session-id'
      })
    };
    
    (global.fetch as any).mockResolvedValue(mockResponse);

    // Create session with proxy
    const session = await createSession({ proxy: mockProxy });

    // Verify session structure
    expect(session.provider).toBe('browserbase');
    expect(session.browserbase).toBeDefined();
    expect(session.browserbase?.id).toBe('test-session-id');
    expect(session.browserbase?.connectUrl).toBe('wss://connect.browserbase.com/test-session-id');
    
    // Verify proxy information is persisted
    expect(session.browserbase?.proxy).toBeDefined();
    expect(session.browserbase?.proxy?.type).toBe('datacenter');
    expect(session.browserbase?.proxy?.id).toBe('oxylabs-us-datacenter-8');
    expect(session.browserbase?.proxy?.geo).toBe('US');
  });

  it('should handle sessions without proxy', async () => {
    // Mock successful session creation response
    const mockResponse = {
      ok: true,
      json: async () => ({
        id: 'test-session-id-2',
        connectUrl: 'wss://connect.browserbase.com/test-session-id-2'
      })
    };
    
    (global.fetch as any).mockResolvedValue(mockResponse);

    // Create session without proxy
    const session = await createSession({});

    // Verify session structure
    expect(session.provider).toBe('browserbase');
    expect(session.browserbase).toBeDefined();
    expect(session.browserbase?.id).toBe('test-session-id-2');
    
    // Verify proxy is undefined
    expect(session.browserbase?.proxy).toBeUndefined();
  });

  it('should pass proxy information when creating browserbase API request', async () => {
    const mockProxy: Proxy = {
      type: 'residential',
      id: 'test-residential-1',
      geo: 'UK',
      url: 'http://residential.proxy.com:8080',
      username: 'user',
      password: 'pass'
    };

    const mockResponse = {
      ok: true,
      json: async () => ({
        id: 'test-session-id-3',
        connectUrl: 'wss://connect.browserbase.com/test-session-id-3'
      })
    };
    
    (global.fetch as any).mockResolvedValue(mockResponse);

    await createSession({ proxy: mockProxy });

    // Verify the API was called with proxy configuration
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.browserbase.com/v1/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-BB-API-Key': 'test-api-key',
          'Content-Type': 'application/json'
        }),
        body: expect.stringContaining('"proxies":[{')
      })
    );

    // Verify the proxy details were included in the request body
    const callArgs = (global.fetch as any).mock.calls[0];
    const requestBody = JSON.parse(callArgs[1].body);
    expect(requestBody.proxies).toBeDefined();
    expect(requestBody.proxies[0]).toMatchObject({
      type: 'external',
      server: 'http://residential.proxy.com:8080',
      username: 'user',
      password: 'pass'
    });
  });
});