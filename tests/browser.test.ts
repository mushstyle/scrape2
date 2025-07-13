import { test, expect } from 'bun:test';
import { createBrowser } from '../src/lib/browser.js';

test('createBrowser - local browser', async () => {
  const { browser, cleanup } = await createBrowser({
    provider: 'local'
  });

  // Verify browser is created
  expect(browser).toBeDefined();
  expect(browser.isConnected()).toBe(true);

  // Verify we can create a page
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://example.com');
  
  const title = await page.title();
  expect(title).toBe('Example Domain');

  // Cleanup
  await cleanup();
  expect(browser.isConnected()).toBe(false);
});

test('createBrowser - browserbase requires sessionId', async () => {
  await expect(createBrowser({
    provider: 'browserbase'
  })).rejects.toThrow('sessionId is required for browserbase provider');
});

test('createBrowser - browserbase requires API key', async () => {
  // Temporarily remove API key
  const originalApiKey = process.env.BROWSERBASE_API_KEY;
  delete process.env.BROWSERBASE_API_KEY;

  await expect(createBrowser({
    provider: 'browserbase',
    sessionId: 'test-session'
  })).rejects.toThrow('BROWSERBASE_API_KEY environment variable is required');

  // Restore API key
  if (originalApiKey) {
    process.env.BROWSERBASE_API_KEY = originalApiKey;
  }
});

test('createBrowser - unknown provider throws', async () => {
  await expect(createBrowser({
    provider: 'unknown' as any
  })).rejects.toThrow('Unknown browser provider: unknown');
});