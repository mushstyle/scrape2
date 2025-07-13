import { test, expect } from 'vitest';
import { createSession as createLocalSession } from '../src/providers/local-browser.js';
import { createSession as createBrowserbaseSession } from '../src/providers/browserbase.js';
import { createBrowserFromSession } from '../src/lib/browser.js';

test('Local browser session', async () => {
  const session = await createLocalSession();
  
  expect(session.provider).toBe('local');
  expect(session.local).toBeDefined();
  expect(session.local?.browser).toBeDefined();
  
  const { browser, createContext, cleanup } = await createBrowserFromSession(session);
  
  // Verify browser is connected
  expect(browser.isConnected()).toBe(true);
  
  // Create context and page
  const context = await createContext();
  const page = await context.newPage();
  await page.goto('https://httpbin.org/user-agent');
  
  const response = await page.textContent('body');
  expect(response).toContain('user-agent');
  
  // Cleanup
  await cleanup();
  expect(browser.isConnected()).toBe(false);
});

test('Local browser session with proxy', async () => {
  const mockProxy = {
    id: 'test-proxy',
    provider: 'test',
    type: 'datacenter' as const,
    geo: 'US',
    url: 'http://proxy.test:8080',
    username: 'testuser',
    password: 'testpass'
  };
  
  const session = await createLocalSession({ proxy: mockProxy });
  
  expect(session.local?.proxy).toEqual(mockProxy);
  
  await session.cleanup();
});

test('createBrowserFromSession with image blocking', async () => {
  const session = await createLocalSession();
  const { createContext, cleanup } = await createBrowserFromSession(session, {
    blockImages: true
  });
  
  const context = await createContext();
  const page = await context.newPage();
  
  // Check that route handler is installed
  const routes = (context as any)._routes;
  expect(routes).toBeDefined();
  expect(routes.length).toBeGreaterThan(0);
  
  await cleanup();
});

test('Browserbase session requires API key', async () => {
  const originalApiKey = process.env.BROWSERBASE_API_KEY;
  delete process.env.BROWSERBASE_API_KEY;
  
  await expect(createBrowserbaseSession()).rejects.toThrow(
    'BROWSERBASE_API_KEY environment variable is required'
  );
  
  // Restore
  if (originalApiKey) {
    process.env.BROWSERBASE_API_KEY = originalApiKey;
  }
});

test('Browserbase session requires project ID', async () => {
  const originalProjectId = process.env.BROWSERBASE_PROJECT_ID;
  process.env.BROWSERBASE_API_KEY = 'test-key';
  delete process.env.BROWSERBASE_PROJECT_ID;
  
  await expect(createBrowserbaseSession()).rejects.toThrow(
    'BROWSERBASE_PROJECT_ID environment variable is required'
  );
  
  // Restore
  if (originalProjectId) {
    process.env.BROWSERBASE_PROJECT_ID = originalProjectId;
  }
});

test('createBrowserFromSession validates session data', async () => {
  const invalidSession = {
    provider: 'browserbase' as const,
    cleanup: async () => {}
  };
  
  await expect(createBrowserFromSession(invalidSession as any)).rejects.toThrow(
    'Invalid session: missing browserbase data'
  );
});